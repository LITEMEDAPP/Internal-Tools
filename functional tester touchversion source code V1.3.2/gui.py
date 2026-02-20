import tkinter as tk
import ttkbootstrap as tb
from ttkbootstrap.constants import *
from tkinter import StringVar, messagebox, filedialog
import threading
import asyncio
from ble_tests import main_test
from excel_utils import save_results_to_excel
from datetime import datetime
from log_database import init_log_db, insert_log, read_logs


class BLETestApp:
    def __init__(self, root):
        self.root = root
        root.title("CURAPOD Functional Test Tool V1.3.2")
        root.geometry("1920x1080")
        root.configure(bg="#000000")
        self.root.protocol("WM_DELETE_WINDOW", self.on_closing)

        init_log_db()

        self.device_logs = {}  # <-- NEW: Store logs per device
        self.last_successful_results = {}  # <-- Store last good test results

        # Top Frame
        self.top_frame = tb.Frame(root, bootstyle="dark", height=70)
        self.top_frame.pack(fill=tk.X, side=tk.TOP)

        curapod_frame = tb.Frame(self.top_frame, bootstyle="dark")
        curapod_frame.pack(side=tk.LEFT, padx=(30, 5), pady=15)

        logo_text = tb.Label(curapod_frame, text="CURAPOD", font=("Arial Black", 24), bootstyle="inverse-dark")
        logo_text.pack(side=tk.LEFT)

        logo_r = tb.Label(curapod_frame, text="®", font=("Arial", 12), bootstyle="inverse-dark")
        logo_r.pack(side=tk.LEFT, anchor="n")  # Aligns to top right

        self.by_label = tb.Label(self.top_frame, text="by Litemed", font=("Arial", 10), bootstyle="inverse-dark")
        self.by_label.pack(side=tk.LEFT, pady=30)

        self.nav_func_test = tb.Label(self.top_frame, text="Functional Test", font=("Arial", 15, "bold"), bootstyle="inverse-dark")
        self.nav_func_test.pack(side=tk.LEFT, padx=60)

        self.nav_dev_reports = tb.Label(self.top_frame, text="Export Report📩", font=("Arial", 15, "bold"), bootstyle="inverse-dark", cursor="hand2")
        self.nav_dev_reports.pack(side=tk.LEFT, padx=20)
        self.nav_dev_reports.bind("<Button-1>", self.export_report)

        self.user_icon = tb.Label(self.top_frame, text="👤", font=("Arial", 20), bootstyle="inverse-dark")
        self.user_icon.pack(side=tk.RIGHT, padx=20)

        self.logs_button = tb.Button(self.top_frame, text="View Logs", bootstyle="secondary", command=self.view_logs)
        self.logs_button.pack(side=tk.RIGHT, padx=10, pady=20)

        self.main_frame = tb.Frame(root, bootstyle="dark")
        self.main_frame.pack(fill=tk.BOTH, expand=True, padx=20, pady=10)

        # Inputs
        self.inputs_frame = tb.Frame(self.main_frame, bootstyle="dark")
        self.inputs_frame.pack(fill=tk.X, pady=(0, 10))

        self.start_var = StringVar()
        self.end_var = StringVar()
        self.total_var = StringVar()

        self.start_frame = tb.Frame(self.inputs_frame, bootstyle="dark")
        self.start_frame.grid(row=0, column=0, padx=20)
        tb.Label(self.start_frame, text="Starting Number", font=("Arial", 12, "bold"), bootstyle="inverse-dark").pack(anchor=tk.W)
        self.start_entry = tb.Entry(self.start_frame, textvariable=self.start_var, font=("Arial", 14), width=16, bootstyle="secondary")
        self.start_entry.pack()

        self.end_frame = tb.Frame(self.inputs_frame, bootstyle="dark")
        self.end_frame.grid(row=0, column=1, padx=20)
        tb.Label(self.end_frame, text="Ending Number", font=("Arial", 12, "bold"), bootstyle="inverse-dark").pack(anchor=tk.W)
        self.end_entry = tb.Entry(self.end_frame, textvariable=self.end_var, font=("Arial", 14), width=16, bootstyle="secondary")
        self.end_entry.pack()

        self.total_frame = tb.Frame(self.inputs_frame, bootstyle="dark")
        self.total_frame.grid(row=0, column=2, padx=20)
        tb.Label(self.total_frame, text="Total devices", font=("Arial", 12, "bold"), bootstyle="inverse-dark").pack(anchor=tk.W)
        self.total_entry = tb.Entry(self.total_frame, textvariable=self.total_var, font=("Arial", 14), width=16, bootstyle="secondary", state="readonly")
        self.total_entry.pack()

        self.append_results_var = tk.BooleanVar(value=True)
        self.append_checkbox = tb.Checkbutton(self.inputs_frame, text="Append Results", variable=self.append_results_var, bootstyle="info")
        self.append_checkbox.grid(row=0, column=3, padx=20)

        # Buttons
        self.buttons_frame = tb.Frame(self.main_frame, bootstyle="dark")
        self.buttons_frame.pack(fill=tk.X, pady=(0, 10))

        self.start_button = tb.Button(self.buttons_frame, text="Start Test", bootstyle="success", width=18, command=self.start_test)
        self.start_button.grid(row=0, column=0, padx=20)

        self.pause_button = tb.Button(self.buttons_frame, text="Pause/Resume Test", bootstyle="primary", width=18, command=self.pause_continue_test)
        self.pause_button.grid(row=0, column=1, padx=20)

        self.end_button = tb.Button(self.buttons_frame, text="End Test", bootstyle="danger", width=18, command=self.end_test)
        self.end_button.grid(row=0, column=2, padx=20)

        # Content + Logs
        self.content_frame = tb.Frame(self.main_frame, bootstyle="dark")
        self.content_frame.pack(fill=tk.BOTH, expand=True)

        self.passed_frame = tb.Labelframe(self.content_frame, text="Passed Devices - 0", bootstyle="success")
        self.passed_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=10, pady=10)

        self.passed_tree = tb.Treeview(self.passed_frame, columns=("Device", "Status"), show="headings", height=20)
        self.passed_tree.heading("Device", text="Device name", command=lambda: self.treeview_sort_column(self.passed_tree, "Device", False))
        self.passed_tree.heading("Status", text="Status", command=lambda: self.treeview_sort_column(self.passed_tree, "Status", False))
        self.passed_tree.column("Device", width=165)
        self.passed_tree.column("Status", width=80)
        self.passed_tree.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        self.failed_frame = tb.Labelframe(self.content_frame, text="Failed Devices - 0", bootstyle="danger")
        self.failed_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=10, pady=10)

        self.failed_tree = tb.Treeview(self.failed_frame, columns=("Device", "Status"), show="headings", height=20)
        self.failed_tree.heading("Device", text="Device name", command=lambda: self.treeview_sort_column(self.failed_tree, "Device", False))
        self.failed_tree.heading("Status", text="Status", command=lambda: self.treeview_sort_column(self.failed_tree, "Status", False))
        self.failed_tree.column("Device", width=165)
        self.failed_tree.column("Status", width=80)
        self.failed_tree.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        self.log_frame = tb.Labelframe(self.content_frame, text="Log Output", bootstyle="info")
        self.log_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=10, pady=10)

        self.log_text = tb.ScrolledText(self.log_frame, height=30, width=60)
        self.log_text.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        self.testing = False
        self.paused = False
        self.test_thread = None
        self.all_results = {}

        self.start_var.set("LMNP-00000")
        self.end_var.set("LMNP-00000")
        self.total_var.set("0")

    def treeview_sort_column(self, tree, col, reverse):
        data = [(tree.set(k, col), k) for k in tree.get_children('')]
        data.sort(reverse=reverse)
        for index, (val, k) in enumerate(data):
            tree.move(k, '', index)
        tree.heading(col, command=lambda: self.treeview_sort_column(tree, col, not reverse))

    def on_closing(self):
        if self.testing:
            messagebox.showwarning("Test Running", "You cannot exit while a test is running.")
        elif self.all_results:
            save_now = messagebox.askyesno("Unsaved Report", "Do you want to save the test results before exiting?")
            if save_now:
                self.export_report()
                return  # Cancel close until save completes or is cancelled
            else:
                self.root.destroy()
        else:
            self.root.destroy()

    def log(self, msg, device=None):
        timestamp = datetime.now().strftime("[%H:%M:%S] ")
        full_msg = timestamp + (f"[{device}] " if device else "") + msg
        self.log_text.insert(tk.END, full_msg + "\n")
        self.log_text.see(tk.END)

        if device:
            if device not in self.device_logs:
                self.device_logs[device] = []
            self.device_logs[device].append(full_msg)

        insert_log(msg, device)

    def show_device_logs(self):
        log_window = tk.Toplevel(self.root)
        log_window.title("Device Logs")
        notebook = tb.Notebook(log_window)
        notebook.pack(fill=tk.BOTH, expand=True)

        for device, logs in self.device_logs.items():
            frame = tb.Frame(notebook)
            notebook.add(frame, text=device)
            text_widget = tk.Text(frame, wrap=tk.WORD)
            text_widget.pack(fill=tk.BOTH, expand=True)
            text_widget.insert(tk.END, "\n".join(logs))
            text_widget.config(state=tk.DISABLED)

    def view_logs(self):
        log_window = tk.Toplevel(self.root)
        log_window.title("Log Viewer")
        log_window.geometry("1200x750")

        # Search bar
        search_frame = tk.Frame(log_window)
        search_frame.pack(fill=tk.X, padx=10, pady=5)
        search_label = tk.Label(search_frame, text="Search:", font=("Arial", 10))
        search_label.pack(side=tk.LEFT)
        search_var = tk.StringVar()
        search_entry = tk.Entry(search_frame, textvariable=search_var, font=("Arial", 10))
        search_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(5, 0))

        # Add scroll bar
        text_frame = tk.Frame(log_window)
        text_frame.pack(fill=tk.BOTH, expand=True)

        scrollbar = tk.Scrollbar(text_frame)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        text_area = tk.Text(text_frame, wrap=tk.WORD, font=("Consolas", 10), yscrollcommand=scrollbar.set)
        text_area.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        scrollbar.config(command=text_area.yview)

        # Load and insert logs
        logs = read_logs(limit=5000000)
        for timestamp, message, device in logs[::-1]:
            device_tag = f"[{device or 'SYSTEM'}]"
            text_area.insert(tk.END, f"[{timestamp}] {device_tag} {message}\n")

        text_area.config(state=tk.DISABLED)

        # Search filter function
        def filter_logs(*args):
            text_area.config(state=tk.NORMAL)
            text_area.delete("1.0", tk.END)
            query = search_var.get().lower()
            for timestamp, message, device in logs[::-1]:
                device_tag = f"[{device or 'SYSTEM'}]"
                line = f"[{timestamp}] {device_tag} {message}\n"
                if query in line.lower():
                    text_area.insert(tk.END, line)
            text_area.config(state=tk.DISABLED)

        search_var.trace_add("write", filter_logs)
        text_area.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        logs = read_logs(limit=5000000)
        for timestamp, message, device in logs[::-1]:
            device_tag = f"[{device or 'SYSTEM'}]"
            text_area.insert(tk.END, f"[{timestamp}] {device_tag} {message}\n")
        text_area.see(tk.END)
        text_area.config(state=tk.DISABLED)



    def update_result(self, device, status):
        for tree in (self.passed_tree, self.failed_tree):
            for item in tree.get_children():
                if tree.item(item, "values")[0] == device:
                    tree.delete(item)
                    break

        if status == "Pass":
            self.passed_tree.insert("", tk.END, values=(device, status))
        else:
            self.failed_tree.insert("", tk.END, values=(device, status))

        self.passed_frame.config(text=f"Passed Devices - {len(self.passed_tree.get_children())}")
        self.failed_frame.config(text=f"Failed Devices - {len(self.failed_tree.get_children())}")
        self.total_var.set(str(len(self.passed_tree.get_children()) + len(self.failed_tree.get_children())))

    def start_test(self):
        if self.testing:
            messagebox.showwarning("Test Running", "Test is already running.")
            return

        self.testing = True
        self.paused = False

        if not self.append_results_var.get():
            self.passed_tree.delete(*self.passed_tree.get_children())
            self.failed_tree.delete(*self.failed_tree.get_children())
            self.log_text.delete("1.0", tk.END)
            self.total_var.set("0")
            self.all_results.clear()

        dev_start = self.start_var.get().strip()
        dev_end = self.end_var.get().strip()

        def log_func(msg):
            self.root.after(0, self.log, msg)

        def update_result(device, status):
            self.root.after(0, self.update_result, device, status)

        def is_paused():
            return self.paused

        def is_stopped():
            return not self.testing

        async def run_tests():
            results = await main_test(log_func, update_result, dev_start, dev_end, is_paused, is_stopped)
            if results:
                self.all_results = results
                self.last_successful_results = results.copy()
            self.log(f"Collected results for {len(self.all_results)} devices.")
            self.testing = False

        def thread_target():
            asyncio.run(run_tests())

        self.test_thread = threading.Thread(target=thread_target, daemon=True)
        self.test_thread.start()

    def pause_continue_test(self):
        if not self.testing:
            messagebox.showinfo("Info", "No test is running to pause or continue.")
            return
        self.paused = not self.paused
        self.log("Test paused." if self.paused else "Test resumed.")

    def end_test(self):
        if not self.testing:
            messagebox.showinfo("Info", "No test is running to end.")
            return
        self.log("Test ended by user.")
        self.testing = False

    def export_report(self, event=None):
        if not self.all_results and self.last_successful_results:
            use_last = messagebox.askyesno("No Current Data", "No current test results. Export last successful results?")
            if use_last:
                self.all_results = self.last_successful_results.copy()

        if not self.all_results:
            messagebox.showinfo("Info", "No test results available to export.")
            return

        filepath = filedialog.asksaveasfilename(
            defaultextension=".xlsx",
            filetypes=[("Excel Files", "*.xlsx")],
            title="Save Excel Report"
        )
        if filepath:
            try:
                save_results_to_excel(self.all_results, filepath)
                messagebox.showinfo("Success", f"Report saved to:\n{filepath}")
                self.all_results.clear()
            except Exception as e:
                messagebox.showerror("Error", f"Failed to save report:\n{str(e)}")

    def on_close(self):
        if self.all_results:
            save_now = messagebox.askyesno("Unsaved Report", "Do you want to save the test results before exiting?")
            if save_now:
                self.export_report()
                return  # Prevent exit until user saves manually or cancels
        self.root.destroy()
