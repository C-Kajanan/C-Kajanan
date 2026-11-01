"""Entry point: `sap2000-mcp` or `python -m sap2000_mcp`. Speaks MCP over stdio."""

from .server import create_server


def main() -> None:
    create_server().run("stdio")


if __name__ == "__main__":
    main()
