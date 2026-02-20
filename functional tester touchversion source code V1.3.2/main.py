from gui import BLETestApp
import ttkbootstrap as tb
from config import (
    WRITE_CHARACTERISTIC_UUID,
    READ_CHARACTERISTIC_UUID,
    STEP_DELAY,
    ACK_TIMEOUT,
    MAX_RETRIES,
    SCAN_DURATION,
    test_steps,
)


def main():
    root = tb.Window(themename="darkly")
    app = BLETestApp(root)
    root.mainloop()

if __name__ == "__main__":
    main()
