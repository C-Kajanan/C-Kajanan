"""A small in-memory stand-in for the SAP2000 OAPI.

It follows the comtypes calling convention: methods with ByRef arguments return
[outputs..., status], others return the status code. Only what the tests need is
implemented; results are canned numbers.
"""

from __future__ import annotations

import math


class _Named:
    def __init__(self) -> None:
        self.items: dict[str, dict] = {}

    def GetNameList(self, n, names):
        keys = list(self.items)
        return [len(keys), tuple(keys), 0]

    def Count(self):
        return len(self.items)


class PointObj(_Named):
    def __init__(self, model) -> None:
        super().__init__()
        self.model = model

    def AddCartesian(self, x, y, z, name, user_name, csys):
        for k, p in self.items.items():
            if math.dist((x, y, z), p["xyz"]) < 1e-9:
                return [k, 0]
        key = user_name or str(len(self.items) + 1)
        self.items[key] = {"xyz": (x, y, z), "restraint": [False] * 6, "loads": []}
        return [key, 0]

    def GetCoordCartesian(self, name, x, y, z, csys):
        if name not in self.items:
            return [0.0, 0.0, 0.0, 1]
        return [*self.items[name]["xyz"], 0]

    def SetRestraint(self, name, r, item):
        if name not in self.items:
            return [r, 1]
        self.items[name]["restraint"] = list(r)
        return [r, 0]

    def GetRestraint(self, name, r):
        return [tuple(self.items[name]["restraint"]), 0]

    def SetLoadForce(self, name, pat, values, replace, csys, item):
        if pat not in self.model.LoadPatterns.items:
            return [values, 1]
        self.items[name]["loads"].append((pat, list(values)))
        return [values, 0]


class FrameObj(_Named):
    def __init__(self, model) -> None:
        super().__init__()
        self.model = model

    def _add(self, pi, pj, name, prop, user):
        key = user or str(len(self.items) + 1)
        self.items[key] = {"points": (pi, pj), "section": prop, "loads": []}
        return [key, 0]

    def AddByCoord(self, xi, yi, zi, xj, yj, zj, name, prop, user, csys):
        pi = self.model.PointObj.AddCartesian(xi, yi, zi, "", "", csys)[0]
        pj = self.model.PointObj.AddCartesian(xj, yj, zj, "", "", csys)[0]
        return self._add(pi, pj, name, prop, user)

    def AddByPoint(self, pi, pj, name, prop, user):
        if pi not in self.model.PointObj.items or pj not in self.model.PointObj.items:
            return ["", 1]
        return self._add(pi, pj, name, prop, user)

    def GetPoints(self, name, a, b):
        return [*self.items[name]["points"], 0]

    def GetSection(self, name, prop, auto):
        return [self.items[name]["section"], "", 0]

    def SetSection(self, name, prop, item):
        targets = list(self.items) if item == 1 and name.upper() == "ALL" else [name]
        for t in targets:
            if t not in self.items:
                return 1
            self.items[t]["section"] = prop
        return 0

    def SetLoadDistributed(self, name, pat, kind, d, d1, d2, v1, v2, csys, rel, replace, item):
        targets = list(self.items) if item == 1 else [name]
        for t in targets:
            self.items[t]["loads"].append(("dist", pat, d, v1, v2))
        return 0

    def SetLoadPoint(self, name, pat, kind, d, dist, val, csys, rel, replace, item):
        self.items[name]["loads"].append(("point", pat, d, dist, val))
        return 0

    def Delete(self, name, item):
        if item == 1:
            self.items.clear()
            return 0
        return 0 if self.items.pop(name, None) is not None else 1


class AreaObj(_Named):
    def __init__(self, model) -> None:
        super().__init__()
        self.model = model

    def AddByCoord(self, n, xs, ys, zs, name, prop, user, csys):
        pts = tuple(self.model.PointObj.AddCartesian(x, y, z, "", "", csys)[0] for x, y, z in zip(xs, ys, zs))
        key = user or str(len(self.items) + 1)
        self.items[key] = {"points": pts, "section": prop, "loads": []}
        return [xs, ys, zs, key, 0]

    def GetPoints(self, name, n, pts):
        p = self.items[name]["points"]
        return [len(p), p, 0]

    def GetProperty(self, name, prop):
        return [self.items[name]["section"], 0]

    def SetProperty(self, name, prop, item):
        for t in (list(self.items) if item == 1 else [name]):
            self.items[t]["section"] = prop
        return 0

    def SetLoadUniform(self, name, pat, value, d, replace, csys, item):
        for t in (list(self.items) if item == 1 else [name]):
            self.items[t]["loads"].append((pat, value, d))
        return 0

    def Delete(self, name, item):
        return 0 if self.items.pop(name, None) is not None else 1


class PropMaterial(_Named):
    def SetMaterial(self, name, t):
        self.items[name] = {"type": t}
        return 0

    def SetMPIsotropic(self, name, e, u, a):
        self.items[name].update(e=e, u=u, a=a)
        return 0

    def AddMaterial(self, name, t, region, std, grade, user):
        key = user or f"{grade}"
        self.items[key] = {"type": t, "grade": grade}
        return [key, 0]

    def SetWeightAndMass(self, name, opt, value):
        self.items[name]["w"] = value
        return 0


class PropFrame(_Named):
    def __init__(self) -> None:
        super().__init__()
        self.items["FSEC1"] = {"shape": "I"}

    def SetRectangle(self, name, mat, t3, t2):
        self.items[name] = {"shape": "rect", "mat": mat, "t3": t3, "t2": t2}
        return 0

    def SetCircle(self, name, mat, t3):
        self.items[name] = {"shape": "circle"}
        return 0

    def SetPipe(self, name, mat, t3, tw):
        self.items[name] = {"shape": "pipe"}
        return 0

    def SetTube(self, name, mat, t3, t2, tf, tw):
        self.items[name] = {"shape": "tube"}
        return 0

    def SetISection(self, name, mat, t3, t2, tf, tw, t2b, tfb):
        self.items[name] = {"shape": "I"}
        return 0

    def ImportProp(self, name, mat, file, prop):
        self.items[name] = {"shape": "imported", "from": prop}
        return 0


class PropArea(_Named):
    def SetShell_1(self, name, t, drill, mat, ang, thick, bend):
        self.items[name] = {"type": t, "thickness": thick}
        return 0


class LoadPatterns(_Named):
    def __init__(self, model) -> None:
        super().__init__()
        self.model = model

    def Add(self, name, t, sw, add_case):
        if name in self.items:
            return 1
        self.items[name] = {"type": t, "sw": sw}
        if add_case:
            self.model.LoadCases.items[name] = {}
        return 0


class RespCombo(_Named):
    def Add(self, name, t):
        self.items[name] = {"type": t, "cases": []}
        return 0

    def SetCaseList(self, name, ctype, cname, sf):
        self.items[name]["cases"].append((ctype, cname, sf))
        return [ctype, 0]


class Analyze:
    def __init__(self, model) -> None:
        self.model = model
        self.flags: dict[str, bool] = {}
        self.ran = False

    def SetRunCaseFlag(self, name, run, all_):
        if all_:
            for c in self.model.LoadCases.items:
                self.flags[c] = run
        else:
            if name not in self.model.LoadCases.items:
                return 1
            self.flags[name] = run
        return 0

    def RunAnalysis(self):
        self.ran = True
        self.model.locked = True
        return 0

    def GetCaseStatus(self, n, names, status):
        cases = list(self.model.LoadCases.items)
        return [len(cases), tuple(cases), tuple(4 if self.flags.get(c) else 1 for c in cases), 0]


class Setup:
    def __init__(self) -> None:
        self.selected: list[tuple[str, str]] = []

    def DeselectAllCasesAndCombosForOutput(self):
        self.selected.clear()
        return 0

    def SetCaseSelectedForOutput(self, name, sel):
        self.selected.append(("case", name))
        return 0

    def SetComboSelectedForOutput(self, name, sel):
        self.selected.append(("combo", name))
        return 0


class Results:
    def __init__(self, model) -> None:
        self.model = model
        self.Setup = Setup()

    def _case(self):
        return self.Setup.selected[0][1] if self.Setup.selected else ""

    def JointDispl(self, name, item, *rest):
        pts = list(self.model.PointObj.items) if item == 2 else [name]
        n = len(pts)
        c = self._case()
        return [n, tuple(pts), tuple(pts), (c,) * n, ("",) * n, (0.0,) * n,
                *[tuple(-0.001 * (i + 1) * k for i in range(n)) for k in range(1, 7)], 0]

    def JointReact(self, name, item, *rest):
        pts = [p for p, v in self.model.PointObj.items.items() if any(v["restraint"])] if item == 2 else [name]
        n = len(pts)
        c = self._case()
        return [n, tuple(pts), tuple(pts), (c,) * n, ("",) * n, (0.0,) * n,
                *[(0.0,) * n, (0.0,) * n, (50.0,) * n, (0.0,) * n, (0.0,) * n, (0.0,) * n], 0]

    def BaseReact(self, *rest):
        c = self._case()
        return [1, (c,), ("",), (0.0,), (0.0,), (0.0,), (100.0,), (0.0,), (0.0,), (0.0,), 0.0, 0.0, 0.0, 0]

    def FrameForce(self, name, item, *rest):
        frames = list(self.model.FrameObj.items) if item == 2 else [name]
        obj, sta = [], []
        for f in frames:
            for s in (0.0, 0.5, 1.0):
                obj.append(f)
                sta.append(s)
        n = len(obj)
        c = self._case()
        m3 = tuple(12.5 * (1 - (2 * s - 1) ** 2) for s in sta)
        return [n, tuple(obj), tuple(sta), tuple(obj), tuple(sta), (c,) * n, ("",) * n, (0.0,) * n,
                (0.0,) * n, (5.0,) * n, (0.0,) * n, (0.0,) * n, (0.0,) * n, m3, 0]

    def ModalPeriod(self, *rest):
        return [2, ("MODAL",) * 2, ("Mode",) * 2, (1.0, 2.0), (0.5, 0.2), (2.0, 5.0), (12.6, 31.4), (158.0, 986.0), 0]


class DesignSteel:
    def __init__(self, model) -> None:
        self.model = model

    def StartDesign(self):
        return 0 if self.model.locked else 1

    def GetSummaryResults(self, name, *rest):
        frames = list(self.model.FrameObj.items)
        ratios = tuple(0.3 + 0.2 * i for i in range(len(frames)))
        n = len(frames)
        return [n, tuple(frames), ratios, (1,) * n, (0.0,) * n, ("COMB1",) * n, ("",) * n, ("",) * n, 0]


class DatabaseTables:
    def GetAvailableTables(self, *a):
        keys = ("Joint Coordinates", "Frame Section Assignments", "Base Reactions")
        return [3, keys, keys, (1, 1, 0), 0]

    def GetAllTables(self, *a):
        return self.GetAvailableTables()

    def GetTableForDisplayArray(self, key, fields, group, version, inc, n, data):
        if key != "Joint Coordinates":
            return [fields, 0, (), 0, (), 1]
        return [fields, 1, ("Joint", "GlobalX"), 2, ("1", "0", "2", "6"), 0]


class File:
    def __init__(self, model) -> None:
        self.model = model

    def NewBlank(self):
        return 0

    def NewGridOnly(self, *a):
        return 0

    def New2DFrame(self, t, stories, h, bays, w, restraint, beam, col, brace):
        pts = {}
        for i in range(bays + 1):
            for j in range(stories + 1):
                pts[(i, j)] = self.model.PointObj.AddCartesian(i * w, 0, j * h, "", "", "Global")[0]
                if j == 0 and restraint:
                    self.model.PointObj.items[pts[(i, j)]]["restraint"] = [True] * 6
        for i in range(bays + 1):
            for j in range(stories):
                self.model.FrameObj._add(pts[(i, j)], pts[(i, j + 1)], "", col, "")
        for i in range(bays):
            for j in range(1, stories + 1):
                self.model.FrameObj._add(pts[(i, j)], pts[(i + 1, j)], "", beam, "")
        return 0

    def New3DFrame(self, *a):
        return 0

    def OpenFile(self, path):
        if not path.lower().endswith(".sdb"):
            return 1
        self.model.filename = path
        return 0

    def Save(self, path):
        self.model.filename = path
        return 0


class View:
    def RefreshView(self, w, z):
        return 0


class SelectObj:
    def __init__(self, model) -> None:
        self.model = model

    def GetSelected(self, *a):
        return [2, (1, 2), ("1", "1"), 0]


class SapModel:
    def __init__(self) -> None:
        self.units = 6
        self.locked = False
        self.filename = ""
        self.PointObj = PointObj(self)
        self.FrameObj = FrameObj(self)
        self.AreaObj = AreaObj(self)
        self.PropMaterial = PropMaterial()
        self.PropFrame = PropFrame()
        self.PropArea = PropArea()
        self.LoadCases = _Named()
        self.LoadCases.items["MODAL"] = {}
        self.LoadPatterns = LoadPatterns(self)
        self.RespCombo = RespCombo()
        self.Analyze = Analyze(self)
        self.Results = Results(self)
        self.DesignSteel = DesignSteel(self)
        self.DesignConcrete = DesignSteel(self)
        self.DatabaseTables = DatabaseTables()
        self.File = File(self)
        self.View = View()
        self.SelectObj = SelectObj(self)

    def GetVersion(self, v, n):
        return ["26.0.0", 26.0, 0]

    def GetModelFilename(self, include_path=True):
        return self.filename

    def GetPresentUnits(self):
        return self.units

    def SetPresentUnits(self, u):
        self.units = u
        return 0

    def GetModelIsLocked(self):
        return self.locked

    def SetModelIsLocked(self, v):
        self.locked = v
        return 0

    def InitializeNewModel(self, units):
        self.__init__()
        self.units = units
        return 0


class SapObject:
    def __init__(self) -> None:
        self.SapModel = SapModel()
        self.exited = False

    def ApplicationExit(self, save):
        self.exited = True
        return 0
