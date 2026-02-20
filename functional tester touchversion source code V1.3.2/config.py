from datetime import datetime
from openpyxl import Workbook

WRITE_CHARACTERISTIC_UUID = "49535343-8841-43f4-a8d4-ecbe34729bb3"
READ_CHARACTERISTIC_UUID = "49535343-1e4d-4bd9-ba61-23c647249616"
STEP_DELAY = 0.5  # seconds, delay between retry steps
COMMAND_RESPONSE_DELAY = 0.5  # seconds, delay after sending a command before expecting a response
ACK_TIMEOUT = 2
MAX_RETRIES = 2
TIMESTAMP_FORMAT = "%H:%M:%S"
SCAN_DURATION = 8  # seconds

test_steps = {
    "Reset TempStats": {
        "command": bytes.fromhex('24 01 19 E6 00 9A 7F 23')+ b'\x0D\x0A',
         "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Reset PmntStats": {
        "command": bytes.fromhex('24 01 22 DD 00 F8 82 23')+ b'\x0D\x0A',
         "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    
    "Sessn (on1)": {
        "command": bytes.fromhex('24 01 06 F9 00 A3 89 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Sessn (off1)":{
        "command": bytes.fromhex('24 01 07 F8 00 F3 D9 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Sessn (on2)": {
        "command": bytes.fromhex('24 01 06 F9 00 A3 89 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Sessn (off2)":{
        "command": bytes.fromhex('24 01 07 F8 00 F3 D9 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Sessn (on3)": {
        "command": bytes.fromhex('24 01 06 F9 00 A3 89 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Sessn (off3)":{
        "command": bytes.fromhex('24 01 07 F8 00 F3 D9 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Sessn (on4)": {
        "command": bytes.fromhex('24 01 06 F9 00 A3 89 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Sessn (off4)":{
        "command": bytes.fromhex('24 01 07 F8 00 F3 D9 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Sessn (on5)": {
        "command": bytes.fromhex('24 01 06 F9 00 A3 89 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    
    
    "Get Stats": {
        "command": bytes.fromhex('24 01 18 E7 00 CA 2F 23')+ b'\x0D\x0A',
         "expected_response": bytes.fromhex('24 01 05 0E 00 00 00 00 00 00 00 00 00 00 05 00 67 52 C7 B6 23')  
    },
    
    "Ping":{
        "command": bytes.fromhex('24 01 09 F6 00 96 7A 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    "Ldr": {
        "command": bytes.fromhex('24 05 0F F0 00 74 EB 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 05 05 02 00 50 49 30 23')  
    },
    "Dose Min.": {
        "command": bytes.fromhex('24 01 0A F5 01 0A 8B BD 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    # "Dose L2": {
    #     "command": bytes.fromhex('24 01 0A F5 01 1E 8B B2 23')+ b'\x0D\x0A',
    #     "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    # },
    # "Dose L3": {
    #     "command": bytes.fromhex('24 01 0A F5 01 32 8A 6F 23')+ b'\x0D\x0A',
    #     "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    # },
    # "Dose L4": {
    #     "command": bytes.fromhex('24 01 0A F5 01 46 8A 48 23')+ b'\x0D\x0A',
    #     "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    # },
    "Dose Max": {
        "command": bytes.fromhex('24 01 0A F5 01 64 0A 51 23')+ b'\x0D\x0A',
        "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    },
    #"C-ON": {
    #    "command": bytes.fromhex('24 01 1D E2 01 AA 3E 75 23')+ b'\x0D\x0A',
    #    "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    #},
    #"Dose set": {
    #    "command": bytes.fromhex('24 01 1B E4 01 41 9E B3 23')+ b'\x0D\x0A',
    #    "expected_response": bytes.fromhex('24 01 05 00 23 50 23')   
    #},
    "Get battery": {
        "command": bytes.fromhex('24 01 05 FA 00 53 79 23')+ b'\x0D\x0A',
        "expected_response": None 
    },
    "Dose read": {
    "command": bytes.fromhex('24 01 1A E5 00 6A 8F 23')+ b'\x0D\x0A',
    "expected_response": None  
    },
    "Device_UID": {
        "command": bytes.fromhex('24 01 17 E8 00 FF DC 23')+ b'\x0D\x0A',
        "expected_response": None 
    },
    "HW_FW_version": {
        "command": bytes.fromhex('24 01 15 EA 00 5F 7C 23')+ b'\x0D\x0A',
        "expected_response": None 
    },
    # "Ack New": {
    #     "command": bytes.fromhex('24 01 1F E0 00 79 DE 23')+ b'\x0D\x0A',
    #     "expected_response": bytes.fromhex('24 01 05 00 23 50 23')   
    # },
    
    
    "Shutdown": {
        "command": bytes.fromhex('24 01 10 EF 00 4C 2D 23')+ b'\x0D\x0A',
         "expected_response": bytes.fromhex('24 01 05 00 23 50 23')  
    }
}
