"""Connection to a running SAP2000 instance through the CSi OAPI (COM).

All COM calls run on one dedicated worker thread. COM objects are bound to the
thread (apartment) that created them, and the MCP event loop must not block
while SAP2000 is analysing a model, so every call is marshalled to that thread.
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, TypeVar

T = TypeVar("T")

PROG_ID = "CSI.SAP2000.API.SapObject"


class SapError(Exception):
    """A SAP2000 API call failed or SAP2000 could not be reached."""


def check(result: Any, what: str) -> list[Any]:
    """Normalise an OAPI return value and raise if it reports failure.

    Through comtypes, OAPI methods without ByRef arguments return the integer
    status code. Methods with ByRef arguments return a list of the ByRef values
    followed by the status code. This returns the ByRef values as a list.
    """
    if isinstance(result, (list, tuple)):
        if not result:
            return []
        *values, code = result
    else:
        values, code = [], result
    if code not in (0, None):
        raise SapError(f"{what} failed (SAP2000 returned {code})")
    return list(values)


class SapConnection:
    """Owns the SapObject and runs work on the COM thread."""

    def __init__(self, factory: Callable[[], Any] | None = None) -> None:
        # `factory` is for tests: it returns an object that behaves like SapObject.
        self._factory = factory
        self._sap_object: Any = None
        self._started_by_us = False
        self._executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="sap2000-com",
            initializer=None if factory else _co_initialize,
        )
        self._lock = threading.Lock()

    # -- thread marshalling -------------------------------------------------

    async def run(self, fn: Callable[[Any], T]) -> T:
        """Run `fn(SapModel)` on the COM thread."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._call, fn)

    async def run_raw(self, fn: Callable[["SapConnection"], T]) -> T:
        """Run `fn(self)` on the COM thread (for connect/disconnect)."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, fn, self)

    def _call(self, fn: Callable[[Any], T]) -> T:
        model = self.model()
        try:
            return fn(model)
        except SapError:
            raise
        except Exception as exc:  # COMError and friends
            if _is_disconnected(exc):
                self._sap_object = None
                raise SapError(
                    "Lost the connection to SAP2000. Is it still running? "
                    "Call the `connect` tool to reconnect."
                ) from exc
            raise SapError(f"{type(exc).__name__}: {exc}") from exc

    # -- connection ---------------------------------------------------------

    def model(self) -> Any:
        """Return SapModel, attaching to a running SAP2000 on first use."""
        if self._sap_object is None:
            self.attach()
        return self._sap_object.SapModel

    def attach(self, start_if_missing: bool | None = None, program_path: str | None = None) -> Any:
        if start_if_missing is None:
            start_if_missing = os.environ.get("SAP2000_MCP_START", "0") == "1"
        if program_path is None:
            program_path = os.environ.get("SAP2000_PATH") or None

        if self._factory is not None:
            self._sap_object = self._factory()
            return self._sap_object

        helper = _helper()
        try:
            self._sap_object = helper.GetObject(PROG_ID)
            self._started_by_us = False
        except Exception as exc:
            if not start_if_missing:
                raise SapError(
                    "Could not find a running SAP2000. Open SAP2000 first, or call "
                    "`connect` with start_new=true (or set SAP2000_MCP_START=1)."
                ) from exc
            self._sap_object = None

        if self._sap_object is None:
            try:
                if program_path:
                    obj = helper.CreateObject(program_path)
                else:
                    obj = helper.CreateObjectProgID(PROG_ID)
                check(obj.ApplicationStart(), "ApplicationStart")
            except SapError:
                raise
            except Exception as exc:
                raise SapError(
                    f"Could not start SAP2000: {exc}. Set SAP2000_PATH to the full "
                    "path of SAP2000.exe if it is not the default install."
                ) from exc
            self._sap_object = obj
            self._started_by_us = True
        return self._sap_object

    def detach(self, close_program: bool = False, save: bool = False) -> None:
        if self._sap_object is not None and close_program:
            check(self._sap_object.ApplicationExit(save), "ApplicationExit")
        self._sap_object = None
        self._started_by_us = False

    @property
    def connected(self) -> bool:
        return self._sap_object is not None

    @property
    def started_by_us(self) -> bool:
        return self._started_by_us


def _co_initialize() -> None:
    if sys.platform != "win32":
        return
    import comtypes  # type: ignore[import-not-found]

    comtypes.CoInitialize()


def _helper() -> Any:
    if sys.platform != "win32":
        raise SapError("SAP2000 runs on Windows only; this server must run on the same Windows machine.")
    try:
        import comtypes.client  # type: ignore[import-not-found]
    except ImportError as exc:
        raise SapError("comtypes is not installed. Run: pip install comtypes") from exc

    try:
        helper = comtypes.client.CreateObject("SAP2000v1.Helper")
        import comtypes.gen.SAP2000v1 as sap_lib  # type: ignore[import-not-found]

        return helper.QueryInterface(sap_lib.cHelper)
    except Exception as exc:
        raise SapError(
            "Could not load the SAP2000 API (SAP2000v1.Helper). Make sure SAP2000 v20 or "
            "later is installed and registered: run RegisterSAP2000.exe from the SAP2000 "
            f"install folder as administrator. Details: {exc}"
        ) from exc


def _is_disconnected(exc: Exception) -> bool:
    text = str(exc).lower()
    hresult = getattr(exc, "hresult", None)
    # RPC_E_DISCONNECTED, RPC_S_SERVER_UNAVAILABLE, CO_E_OBJNOTCONNECTED
    return hresult in (-2147417848, -2147023174, -2147220995) or "disconnected" in text or "rpc server" in text
