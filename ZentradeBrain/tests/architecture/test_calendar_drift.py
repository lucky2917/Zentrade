"""The NSE session calendar is GENERATED from the ZenTrade JS kernel, not."""
import json
import os
import re
from pathlib import Path

import pytest

from zentrade.kernel.clock import CALENDAR_PATH

JS_ROOT = Path(os.getenv("ZENTRADE_JS_ROOT", "/Users/ravijoshu/Zentrade"))
KERNEL_SRC = JS_ROOT / "packages/kernel/src/time/marketHours.ts"


def test_calendar_file_is_wellformed():
    data = json.loads(CALENDAR_PATH.read_text())
    assert data["session"]["open"] == "09:15"
    assert data["session"]["close"] == "15:30"
    assert data["session"]["days"] == [1, 2, 3, 4, 5]
    assert len(data["holidays"]) > 0
    assert data["holidays"] == sorted(data["holidays"]), "holidays must be sorted"


@pytest.mark.skipif(not KERNEL_SRC.exists(), reason="ZENTRADE_JS_ROOT not available")
def test_generated_calendar_still_matches_the_js_kernel():
    block = re.search(r"NSE_HOLIDAYS[^=]*=\s*new Set\(\[(.*?)\]\)", KERNEL_SRC.read_text(), re.S)
    assert block, "could not locate NSE_HOLIDAYS in the JS kernel"
    from_kernel = sorted(re.findall(r'"(\d{4}-\d{2}-\d{2})"', block.group(1)))
    from_json = sorted(json.loads(CALENDAR_PATH.read_text())["holidays"])
    assert from_json == from_kernel, (
        "reference/nse_calendar.json has drifted from the JS kernel; regenerate it"
    )
