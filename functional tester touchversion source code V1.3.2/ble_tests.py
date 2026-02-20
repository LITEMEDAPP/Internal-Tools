import asyncio
from bleak import BleakClient, BleakScanner
from config import *
from excel_utils import save_results_to_excel
from config import TIMESTAMP_FORMAT
from datetime import datetime

all_results = {}
passed_devices = []
failed_devices = []
devices_to_retry = []

async def main_test(log_func, update_result, dev_start, dev_end, is_paused, is_stopped):
    log_func("Scanning for BLE devices...")

    devices_to_retry.clear()

    devices = await BleakScanner.discover(timeout=SCAN_DURATION)
    matched = [(d.name, d.address) for d in devices if d.name]
    for name, _ in matched:
        if name in passed_devices:
            log_func(f"[{name}] ✅ Already passed. Skipping.")

    # Filter devices based on user-defined name range (dev_start <= name <= dev_end)
    filtered = [
        (name, addr)
        for name, addr in matched
        if dev_start <= name <= dev_end and name not in passed_devices
    ]
  
    if not filtered:
        log_func("No new devices found in specified range.")
        return {}

    log_func(f"Found {len(filtered)} matching device(s).")

    tasks = []
    for name, addr in filtered:
        if name in passed_devices:
            #log_func(f"[{name}] ✅ Already passed. Skipping.")
            continue
        if is_stopped():
            log_func("Testing stopped. Skipping remaining devices.")
            break
        tasks.append(perform_test(name, addr, log_func, update_result, is_paused, is_stopped)) #Each device test runs concurrently

    if tasks:
        await asyncio.gather(*tasks)
    else:
        log_func("No new devices to test.")

    if not is_stopped() and devices_to_retry:
        log_func(f"\n🔁 Starting retry for {len(devices_to_retry)} failed devices...")
        await retry_failed_devices(log_func, update_result, is_paused, is_stopped)

    log_func("All tests and retries completed.")
    return all_results


async def wait_for_notification_event(event, timeout=ACK_TIMEOUT):
    try:
        await asyncio.wait_for(event.wait(), timeout)
        return True
    except asyncio.TimeoutError:
        return False
    
async def perform_test(device_name, address, log_func, update_result, is_paused, is_stopped):
    step_results = []
    if is_stopped():
        log_func(f"[{device_name}] Test skipped (testing stopped).")
        return

    start_time = datetime.now().strftime(TIMESTAMP_FORMAT)
    try:
        log_func(f"[{device_name}] 🔌 Connecting to device...")
        async with BleakClient(address) as client:
            log_func(f"[{device_name}] Connected at {start_time}.")
            notification_event = asyncio.Event()
            last_response = {}
            last_command = ""
            # Predefine variables to avoid missing values
            get_bat_response = ""
            dev_uid_response = ""
            dev_HW_FW_version = ""
            dose_read_response = ""


            def handle_notification(_, data):
                last_response['data'] = data
                notification_event.set()

            await client.start_notify(READ_CHARACTERISTIC_UUID, handle_notification)
            step_results = []

            for test_name, test_data in test_steps.items():
                command = test_data["command"]
                expected_response = test_data.get("expected_response")

                if is_stopped():
                    log_func(f"[{device_name}] Test stopped.")
                    break

                while is_paused():
                    await asyncio.sleep(0.1)

                success = False
                response_matched = False
                for attempt in range(1, MAX_RETRIES + 1):
                    try:
                        notification_event.clear()
                        last_response['data'] = None

                        log_func(f"[{device_name}] Sending: {test_name} (Attempt {attempt})")
                        last_command = command.hex()

                        await client.write_gatt_char(WRITE_CHARACTERISTIC_UUID, command)
                        await asyncio.sleep(COMMAND_RESPONSE_DELAY)

                        #if "Shutdown" in test_name:
                        #   success = True
                        #  break

                        got_response = await wait_for_notification_event(notification_event)

                        if got_response and last_response.get('data'):
                            received = last_response['data']

                            # Combined command and response in single line
                            log_func(f"[{device_name}] CMD: {test_name} | RSP: {received.hex()}")

                            # if test_name == "Dose set":
                            #     dose_set_response = received.hex()
                            if test_name == "Get battery":
                                raw = received
                          
                                if len(raw) >= 7:
                                    bat_bytes = raw[4:5]          # bytes 11 and 12 (0-indexed)
                                    get_bat_response = int.from_bytes(bat_bytes, byteorder='little')
                                else:
                                    get_bat_response = raw.hex()   # fallback

                                log_func(f"battery percentage Value: {get_bat_response}")
                            if test_name == "Dose read":
                                raw = received
                          
                                if len(raw) >= 12:
                                    dose_bytes = raw[10:12]          # bytes 11 and 12 (0-indexed)
                                    dose_read_response = dose_bytes.hex()
                                else:
                                    dose_read_response = raw.hex()   # fallback

                                log_func(f"📌 Dose Value: {dose_read_response}")

                            if test_name == "Device_UID":
                                raw = received 

                                if len(raw) >= 5:
                                    uid_bytes = raw[4:14]          # bytes 5 and 14 (0-indexed)
                                    dev_uid_response = uid_bytes.hex()
                                else:
                                    dev_uid_response = raw.hex()   # fallback

                                log_func(f"📌 Dev UID Extracted Value: {dev_uid_response}")
                                
                            if test_name == "HW_FW_version": 
                                raw = received 
                                if len(raw) >= 5:
                                    hwfw_bytes = raw[4:8]          # bytes 5 and 8 (0-indexed)
                                    dev_HW_FW_version = hwfw_bytes.hex()
                                else:
                                    dev_HW_FW_version = raw.hex()   # fallback

                                log_func(f"📌 Dev HW FW Extracted Value: {dev_HW_FW_version}")
                                

                            if expected_response:
                                if received == expected_response:
                                    log_func("✅ Response matches expected value")
                                    response_matched = True
                                    success = True
                                    break
                                else:
                                    log_func(f"❌ Response mismatch (Expected: {expected_response.hex()})")
                            else:
                                log_func("⚠ No expected response defined, accepting any response")
                                success = True
                                break
                        else:
                            log_func(f"[{device_name}] CMD: {test_name} | RSP: <No Response>")

                    except Exception as e:
                        log_func(f" ERROR: {str(e)}")
                        

                    if expected_response and not response_matched:
                        if attempt < MAX_RETRIES:
                            log_func(f"↻ Retrying {test_name}...")
                            await asyncio.sleep(STEP_DELAY)
                        continue
                    break

                step_results.append("Pass" if success else "Fail")
                if not success:
                    log_func(f"❌ Failed after {MAX_RETRIES} attempts")

            await client.stop_notify(READ_CHARACTERISTIC_UUID)

            end_time = datetime.now().strftime(TIMESTAMP_FORMAT)
            all_results[device_name] = {
                    "address": address,
                    "steps": step_results,
                    "start_time": start_time,
                    "end_time": end_time,
                    "get_bat_response" : get_bat_response if 'get_bat_response' in locals() else "",
                    "dose_set_response": dose_read_response if 'dose_read_response' in locals() else "",
                    "dev_uid_response": dev_uid_response if 'dev_uid_response' in locals() else "",
                    "dev_HW_FW_version": dev_HW_FW_version if 'dev_HW_FW_version' in locals() else ""
            }


            if len(step_results) == len(test_steps) and all(r == "Pass" for r in step_results):
                status = "Pass"
            else:
                status = "Fail"

            (passed_devices if status == "Pass" else failed_devices).append(device_name)

            if status == "Fail" and device_name not in devices_to_retry:
                devices_to_retry.append(device_name)

            update_result(device_name, status)
            log_func(f"[{device_name}] Test complete.\n")

    except Exception as e:
        log_func(f"[{device_name}] Connection failed: {e}")
        step_results = ["Fail"]*len(test_steps)
        end_time = datetime.now().strftime(TIMESTAMP_FORMAT)
        all_results[device_name] = {
                    "address": address,
                    "steps": step_results,
                    "start_time": start_time,
                    "end_time": end_time,
                    "get_bat_response" : get_bat_response if 'get_bat_response' in locals() else "",
                    "dose_set_response": dose_read_response if 'dose_read_response' in locals() else "",
                    "dev_uid_response": dev_uid_response if 'dev_uid_response' in locals() else "",
                    "dev_HW_FW_version": dev_HW_FW_version if 'dev_HW_FW_version' in locals() else ""
            }
        failed_devices.append(device_name)

        if device_name not in devices_to_retry:  #Avoides duplicate retry tests on failed devices
            devices_to_retry.append(device_name)

        update_result(device_name, "Fail")

async def retry_failed_devices(log_func, update_result, is_paused, is_stopped):
    global devices_to_retry
    to_retry = devices_to_retry.copy()
    devices_to_retry.clear()  # Clear current retry list for updated failures

    if not to_retry:
        return

    log_func(f"Retrying {len(to_retry)} failed device(s) in parallel...")

    tasks = []
    for device_name in to_retry:
        if is_stopped():
            log_func("Retry aborted: testing was stopped.")
            break
        address = all_results[device_name]["address"]
        tasks.append(perform_test(device_name, address, log_func, update_result, is_paused, is_stopped))

    if tasks:
        await asyncio.gather(*tasks)

