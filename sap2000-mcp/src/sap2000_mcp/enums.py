"""OAPI enumeration values, keyed by the friendly names the tools accept."""

UNITS = {
    "lb_in_F": 1, "lb_ft_F": 2, "kip_in_F": 3, "kip_ft_F": 4,
    "kN_mm_C": 5, "kN_m_C": 6, "kgf_mm_C": 7, "kgf_m_C": 8,
    "N_mm_C": 9, "N_m_C": 10, "Ton_mm_C": 11, "Ton_m_C": 12,
    "kN_cm_C": 13, "kgf_cm_C": 14, "N_cm_C": 15, "Ton_cm_C": 16,
}
UNITS_BY_ID = {v: k for k, v in UNITS.items()}

MATERIAL_TYPES = {
    "steel": 1, "concrete": 2, "nodesign": 3, "aluminum": 4,
    "coldformed": 5, "rebar": 6, "tendon": 7,
}

LOAD_PATTERN_TYPES = {
    "dead": 1, "superdead": 2, "live": 3, "reducelive": 4, "quake": 5,
    "wind": 6, "snow": 7, "other": 8, "move": 9, "temperature": 10,
    "rooflive": 11, "notional": 12,
}

COMBO_TYPES = {"linear_add": 0, "envelope": 1, "absolute_add": 2, "srss": 3, "range_add": 4}

SHELL_TYPES = {"shell_thin": 1, "shell_thick": 2, "plate_thin": 3, "plate_thick": 4, "membrane": 5}

# Load directions accepted by SetLoadDistributed / SetLoadPoint / SetLoadUniform.
LOAD_DIRECTIONS = {
    "local_1": 1, "local_2": 2, "local_3": 3,
    "x": 4, "y": 5, "z": 6,
    "x_proj": 7, "y_proj": 8, "z_proj": 9,
    "gravity": 10, "gravity_proj": 11,
}

FRAME_2D_TYPES = {"portal": 0, "concentric_braced": 1, "eccentric_braced": 2}
FRAME_3D_TYPES = {"open_frame": 0, "perimeter_frame": 1, "beam_slab": 2, "flat_plate": 3}

RESTRAINT_PRESETS = {
    "fixed": [True] * 6,
    "pinned": [True, True, True, False, False, False],
    "roller": [False, False, True, False, False, False],
    "free": [False] * 6,
}

# eItemTypeElm for results, eItemType for assignments.
ELM_OBJECT, ELM_GROUP = 0, 2
ITEM_OBJECT, ITEM_GROUP = 0, 1


def lookup(table: dict[str, int], key: str, what: str) -> int:
    k = key.strip()
    for name, value in table.items():
        if name.lower() == k.lower():
            return value
    raise ValueError(f"Unknown {what} '{key}'. Use one of: {', '.join(table)}")
