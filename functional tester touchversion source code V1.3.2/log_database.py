# log_database.py

import sqlite3
from datetime import datetime

# Database filename
DB_FILE = "test_logs.db"

def init_log_db():
    """Initialize the log database and create table if it doesn't exist."""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            message TEXT,
            device TEXT
        )
    ''')
    conn.commit()
    conn.close()

def insert_log(message, device=None):
    """Insert a log message with a timestamp and optional device name into the database."""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute("INSERT INTO logs (timestamp, message, device) VALUES (?, ?, ?)", (timestamp, message, device))
    conn.commit()
    conn.close()

def read_logs(limit=5000000):
    """Fetch and return the most recent logs from the database."""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute("SELECT timestamp, message, device FROM logs ORDER BY id DESC LIMIT ?", (limit,))
    logs = cursor.fetchall()
    conn.close()
    return logs
