import asyncio
import threading
import tkinter as tk
from tkinter import ttk, scrolledtext, filedialog, messagebox
from bleak import BleakClient, BleakScanner
from openpyxl import Workbook
from datetime import datetime
import shutil

# ================= CONFIGURATION =================

WRITE_CHARACTERISTIC_UUID = "49535343-8841-43f4-a8d4-ecbe34729bb3"
READ_CHARACTERISTIC_UUID  = "49535343-1e4d-4bd9-ba61-23c647249616"

SCAN_DURATION = 8
BATTERY_INTERVAL = 20
ACK_TIMEOUT = 5
MAX_CONNECT_RETRIES = 5
RETRY_DELAY = 3

SESSION_ON_COMMAND    = bytes.fromhex("24 01 06 F9 00 A3 89 23") + b'\x0D\x0A'
BATTERY_QUERY_COMMAND = bytes.fromhex("24 02 05 FA 00 53 3D 23") + b'\x0D\x0A'
PING_DEVICES          = bytes.fromhex("24 01 09 F6 00 96 7A 23") + b'\x0D\x0A'

BATTERY_RESPONSE_OPCODE = 0x02
COMMON_ACK_OPCODE = 0x00

# ================= GLOBAL CONTROL =================

stop_event = threading.Event()
ping_counter = 0
ping_lock = threading.Lock()

now_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
excel_filename = f"Battery_Log_{now_str}.xlsx"

wb = Workbook()
ws = wb.active
ws.title = "Battery Log"
ws.append(["Timestamp", "Device Name", "Battery %"])

# ================= HELPERS =================

def parse_battery_percentage(data):
    """
    Accept battery only if opcode == 0x01
    Ignore common ACK responses (opcode 0x00)
    """
    try:
        if not data or len(data) < 6:
            return None

        opcode = data[1]

        if opcode == COMMON_ACK_OPCODE:
            return None

        if opcode != BATTERY_RESPONSE_OPCODE:
            return None

        return data[4]

    except Exception:
        return None


async def wait_for_notification(event, timeout=ACK_TIMEOUT):
    try:
        await asyncio.wait_for(event.wait(), timeout)
        return True
    except asyncio.TimeoutError:
        return False


def extract_number(name):
    try:
        return int(name.split("-")[-1])
    except Exception:
        return None

# ================= DEVICE MONITOR =================

async def monitor_device(device_name, address, log_func):
    retries = 0

    while not stop_event.is_set():
        try:
            log_func(f"[{device_name}] Connecting (try {retries + 1})")

            async with BleakClient(address) as client:
                await client.connect()

                log_func(f"[{device_name}] Connected")
                retries = 0

                notification_event = asyncio.Event()
                last_response = {}

                def handle_notification(_, data):
                    last_response["data"] = data
                    notification_event.set()

                await client.start_notify(
                    READ_CHARACTERISTIC_UUID,
                    handle_notification
                )

                # ---- SESSION ON ----
                await client.write_gatt_char(
                    WRITE_CHARACTERISTIC_UUID,
                    SESSION_ON_COMMAND
                )
                log_func(f"[{device_name}] Session ON sent")

                last_battery_time = 0
                last_ping_seen = -1

                while not stop_event.is_set():
                    if not client.is_connected:
                        raise RuntimeError("BLE link lost")

                    # ---------- PING ----------
                    with ping_lock:
                        current_ping = ping_counter

                    if current_ping != last_ping_seen:
                        last_ping_seen = current_ping
                        await client.write_gatt_char(
                            WRITE_CHARACTERISTIC_UUID,
                            PING_DEVICES
                        )
                        log_func(f"[{device_name}] Ping sent")

                    # ---------- BATTERY ----------
                    now = asyncio.get_event_loop().time()
                    if now - last_battery_time >= BATTERY_INTERVAL:
                        last_battery_time = now

                        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                        notification_event.clear()
                        last_response.clear()

                        await client.write_gatt_char(
                            WRITE_CHARACTERISTIC_UUID,
                            BATTERY_QUERY_COMMAND
                        )

                        if await wait_for_notification(notification_event):
                            rsp = last_response.get("data")
                            log_func(f"[{device_name}] response = {rsp.hex()} at {timestamp}")
                            battery = parse_battery_percentage(
                                last_response.get("data")
                            )

                            if battery is not None:
                                log_func(
                                    f"[{device_name}] Battery = {battery}% at {timestamp}"
                                )
                                ws.append([timestamp, device_name, battery])
                                wb.save(excel_filename)
                            else:
                                log_func(
                                    f"[{device_name}] logs battery response in every 20 seconds"
                                )
                        else:
                            log_func(f"[{device_name}] Battery response timeout")

                    await asyncio.sleep(0.3)

        except Exception as e:
            retries += 1
            log_func(f"[{device_name}] message: {e}")

            if retries >= MAX_CONNECT_RETRIES:
                log_func(f"[{device_name}] Backing off...")
                retries = 0
                await asyncio.sleep(10)
            else:
                await asyncio.sleep(RETRY_DELAY)

# ================= MAIN MONITOR =================

async def main_monitor(log_func, prefix, start_name, end_name):
    log_func(f"Scanning for prefix '{prefix}'")

    devices = await BleakScanner.discover(
        timeout=SCAN_DURATION,
        return_adv=True
    )

    matched = []

    start_num = extract_number(start_name)
    end_num = extract_number(end_name)

    for device, adv in devices.values():
        name = adv.local_name or device.name
        if not name or not name.startswith(prefix):
            continue

        if prefix == "LMNP-" and start_num is not None and end_num is not None:
            num = extract_number(name)
            if num is None or not (start_num <= num <= end_num):
                continue

        matched.append((name, device.address))

    if not matched:
        log_func("No matching devices found")
        return

    log_func(f"Found {len(matched)} device(s)")

    await asyncio.gather(
        *(monitor_device(name, addr, log_func) for name, addr in matched)
    )

# ================= GUI =================

def ping_devices():
    global ping_counter
    with ping_lock:
        ping_counter += 1
    log_message("Ping requested")


def log_message(msg):
    log_text.insert(tk.END, msg + "\n")
    log_text.see(tk.END)


def run_monitor_thread():
    stop_event.clear()

    def runner():
        asyncio.run(
            main_monitor(
                log_message,
                prefix_var.get(),
                device_start_entry.get(),
                device_end_entry.get(),
            )
        )

    threading.Thread(target=runner, daemon=True).start()


def stop_monitoring():
    stop_event.set()
    log_message("Stopping monitoring...")


def download_excel():
    save_path = filedialog.asksaveasfilename(
        defaultextension=".xlsx",
        filetypes=[("Excel files", "*.xlsx")]
    )
    if save_path:
        wb.save(excel_filename)
        shutil.copy(excel_filename, save_path)
        messagebox.showinfo("Saved", "Excel report saved")


def on_prefix_change(_=None):
    state = tk.NORMAL if prefix_var.get() == "LMNP-" else tk.DISABLED
    device_start_entry.config(state=state)
    device_end_entry.config(state=state)

# ================= UI =================

root = tk.Tk()
root.title("BLE Battery Monitor Tool")
root.geometry("950x600")

left = ttk.Frame(root)
left.pack(side=tk.LEFT, fill=tk.Y, padx=10)

right = ttk.Frame(root)
right.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True)

prefix_var = tk.StringVar(value="LMNP-")

ttk.Label(left, text="Device Prefix").pack(anchor="w")
prefix_dropdown = ttk.Combobox(
    left,
    textvariable=prefix_var,
    values=["LMNP-", "RN4870"],
    state="readonly"
)
prefix_dropdown.pack(fill="x")
prefix_dropdown.bind("<<ComboboxSelected>>", on_prefix_change)

ttk.Label(left, text="Device Start").pack(anchor="w")
device_start_entry = ttk.Entry(left)
device_start_entry.insert(0, "LMNP-0000000211")
device_start_entry.pack(fill="x")

ttk.Label(left, text="Device End").pack(anchor="w")
device_end_entry = ttk.Entry(left)
device_end_entry.insert(0, "LMNP-0000000212")
device_end_entry.pack(fill="x")

ttk.Button(left, text="Start Monitoring", command=run_monitor_thread).pack(fill="x", pady=5)
ttk.Button(left, text="Stop Monitoring", command=stop_monitoring).pack(fill="x", pady=5)
ttk.Button(left, text="Ping Devices", command=ping_devices).pack(fill="x", pady=5)
ttk.Button(left, text="Download Excel", command=download_excel).pack(fill="x", pady=5)

ttk.Label(right, text="Log Output", font=("Helvetica", 14)).pack()
log_text = scrolledtext.ScrolledText(right, wrap=tk.WORD)
log_text.pack(fill=tk.BOTH, expand=True)

on_prefix_change()
root.mainloop()
