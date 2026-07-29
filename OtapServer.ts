/**
 * MCXW71 BLE OTAP Server - React Native port (react-native-ble-plx).
 *
 * Mirrors the same structure as the Python (bleak) and Web Bluetooth versions:
 *   OtapImage        <-> OtapImage
 *   BlockRequest      <-> parseBlockRequest()
 *   OtapServer.run()  <-> run()
 *   .trigger_ota_via_wireless_uart() <-> triggerOtaViaWirelessUart()
 *   .run_ota()        <-> runOta()
 *   .send_block()     <-> sendBlock()
 */

import { BleManager, Device, Characteristic, Subscription } from 'react-native-ble-plx';

// ============================================================
// Base64 <-> Uint8Array helpers
// react-native-ble-plx represents characteristic values as base64 strings,
// not raw bytes - these convert so the rest of the code can stay byte-based,
// matching the other language versions exactly.
// ============================================================
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    result += B64_CHARS[(triplet >> 18) & 0x3f];
    result += B64_CHARS[(triplet >> 12) & 0x3f];
    result += b1 !== undefined ? B64_CHARS[(triplet >> 6) & 0x3f] : '=';
    result += b2 !== undefined ? B64_CHARS[triplet & 0x3f] : '=';
  }
  return result;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const val = B64_CHARS.indexOf(char);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');

// ============================================================
// OTAP protocol constants (identical across every version)
// ============================================================
export const SERVICE_OTAP = '01ff5550-ba5e-f4ee-5ca1-eb1e5e4b1ce0';
export const CHAR_CONTROL_POINT = '01ff5551-ba5e-f4ee-5ca1-eb1e5e4b1ce0';
export const CHAR_DATA = '01ff5552-ba5e-f4ee-5ca1-eb1e5e4b1ce0';

export const SERVICE_WU = '01ff0100-ba5e-f4ee-5ca1-eb1e5e4b1ce0';
export const CHAR_WU_WRITE = '01ff0101-ba5e-f4ee-5ca1-eb1e5e4b1ce0';

const CMD = {
  NEW_IMAGE_NOTIFICATION: 0x01,
  NEW_IMAGE_INFO_REQUEST: 0x02,
  NEW_IMAGE_INFO_RESPONSE: 0x03,
  IMAGE_BLOCK_REQUEST: 0x04,
  IMAGE_CHUNK: 0x05,
  IMAGE_TRANSFER_COMPLETE: 0x06,
  ERROR_NOTIFICATION: 0x07,
  STOP_IMAGE_TRANSFER: 0x08,
} as const;

const TRANSFER_ATT = 0x00;
const TRANSFER_L2CAP = 0x01;

/** The "enter OTA mode" trigger command - identical bytes used in every version. */
export const WU_OTA_TRIGGER_CMD = new Uint8Array([
  0x24, 0x01, 0x55, 0xaa, 0x00, 0x6f, 0x68, 0x23, 0x0d, 0x0a,
]);

type Logger = (msg: string) => void;

// ============================================================
// OtapImage - wraps the .bleota file bytes and serves byte ranges
// ============================================================
export class OtapImage {
  readonly data: Uint8Array;
  readonly imageId: number;
  readonly version: Uint8Array;

  constructor(data: Uint8Array, log: Logger) {
    this.data = data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== 0x0b1ef11e) {
      throw new Error(`Not a valid OTAP image file (bad magic: 0x${magic.toString(16)})`);
    }
    this.imageId = view.getUint16(12, true);
    this.version = data.slice(14, 22);
    log(`Loaded OTAP image -> ${data.length} bytes, image_id=${this.imageId}`);
  }

  get size(): number {
    return this.data.length;
  }

  range(start: number, length: number): Uint8Array {
    const end = Math.min(start + length, this.data.length);
    return this.data.slice(start, end);
  }
}

// ============================================================
// BlockRequest - parses an Image Block Request (0x04)
// ============================================================
export interface BlockRequest {
  imageId: number;
  start: number;
  blockSize: number;
  chunkSize: number;
  method: number;
  l2capOrPsm: number;
}

export function parseBlockRequest(payload: Uint8Array, log: Logger): BlockRequest {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const imageId = view.getUint16(1, true);
  const start = view.getUint32(3, true);
  const blockSize = view.getUint32(7, true);
  const chunkSize = view.getUint16(11, true);
  const method = view.getUint8(13);
  const l2capOrPsm = view.getUint16(14, true);
  log(
    `Block Request -> image_id=${imageId}, start=${start}, block_size=${blockSize}, ` +
      `chunk_size=${chunkSize}, method=${method === TRANSFER_L2CAP ? 'L2CAP' : 'ATT'}, l2cap_or_psm=${l2capOrPsm}`,
  );
  return { imageId, start, blockSize, chunkSize, method, l2capOrPsm };
}

/** 0x03: CmdId + ImageId(2) + Version(8) + FileSize(4) */
export function newImageInfoResponse(img: OtapImage, log: Logger): Uint8Array {
  log(`New Image Info Response -> image_id=${img.imageId}, version=${hex(img.version)}, size=${img.size} bytes`);
  const buf = new ArrayBuffer(1 + 2 + 8 + 4);
  const view = new DataView(buf);
  view.setUint8(0, CMD.NEW_IMAGE_INFO_RESPONSE);
  view.setUint16(1, img.imageId, true);
  new Uint8Array(buf, 3, 8).set(img.version);
  view.setUint32(11, img.size, true);
  return new Uint8Array(buf);
}

/** 0x05: CmdId + SeqNumber(1) + Data */
export function imageChunk(seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + payload.length);
  out[0] = CMD.IMAGE_CHUNK;
  out[1] = seq & 0xff;
  out.set(payload, 2);
  return out;
}

// ============================================================
// OtapServer - mirrors the Python/Kotlin/Web OtapServer class
// ============================================================
export interface OtapServerOptions {
  manager: BleManager;
  image?: OtapImage;
  useWirelessUart?: boolean;
  log: Logger;
  onProgress?: (sent: number, total: number) => void;
}

export class OtapServer {
  private manager: BleManager;
  private image?: OtapImage;
  private useWirelessUart: boolean;
  private log: Logger;
  private onProgress: (sent: number, total: number) => void;
  private totalSent = 0;
  private abort = false;

  constructor(opts: OtapServerOptions) {
    this.manager = opts.manager;
    this.image = opts.image;
    this.useWirelessUart = opts.useWirelessUart ?? true;
    this.log = opts.log;
    this.onProgress = opts.onProgress ?? (() => {});
  }

  async run(): Promise<boolean> {
    if (this.useWirelessUart) {
      const triggered = await this.triggerOtaViaWirelessUart();
      if (!triggered) return false;
    }
    return this.runOta();
  }

  /** Scan for + connect to the device in normal (Wireless UART) mode, send the trigger, disconnect.
   *  Public so this specific step can be triggered on its own from the UI, independent of run(). */
  async triggerOtaViaWirelessUart(): Promise<boolean> {
    this.log('Scanning for device (Wireless UART mode) ...');
    const device = await this.scanForDevice(SERVICE_WU, 10000);
    if (!device) {
      this.log('No Wireless UART device found.');
      return false;
    }

    this.log(`Connecting to ${device.name ?? device.id} (Wireless UART) ...`);
    const connected = await device.connect();
    await connected.discoverAllServicesAndCharacteristics();

    this.log(`Writing OTA trigger command to WU characteristic: ${hex(WU_OTA_TRIGGER_CMD)}`);
    await connected.writeCharacteristicWithoutResponseForService(
      SERVICE_WU,
      CHAR_WU_WRITE,
      bytesToBase64(WU_OTA_TRIGGER_CMD),
    );

    await new Promise((r) => setTimeout(r, 300));
    await connected.cancelConnection();

    this.log('Trigger sent - device should reboot into OTA mode.');
    return true;
  }

  /** Scan for + connect to the OTAP device, run the handshake and dispatch loop. */
  private async runOta(): Promise<boolean> {
    if (!this.image) {
      this.log('No firmware image loaded - cannot run OTAP transfer.');
      return false;
    }
    const image = this.image;

    this.log('Scanning for OTAP device ...');
    const device = await this.scanForDevice(SERVICE_OTAP, 30000);
    if (!device) {
      this.log('No OTAP device found.');
      return false;
    }

    this.log(`Connecting to ${device.name ?? device.id} ...`);
    const connected = await device.connect();
    await connected.discoverAllServicesAndCharacteristics();

    // Check the Control Point's actual properties before subscribing, same
    // diagnostic style as the generic scanner (isNotifiable / isIndicatable).
    const otapChars = await connected.characteristicsForService(SERVICE_OTAP);
    const controlPointChar = otapChars.find((c) => c.uuid.toLowerCase() === CHAR_CONTROL_POINT.toLowerCase());
    if (controlPointChar) {
      this.log(
        `Control Point properties: Notify=${controlPointChar.isNotifiable} ` +
          `Indicate=${controlPointChar.isIndicatable} Write=${controlPointChar.isWritableWithResponse}`,
      );
    }

    // Subscribing via monitorCharacteristicForService is react-native-ble-plx's
    // "subscribe" mechanism - it automatically enables Notify or Indicate under
    // the hood based on the characteristic's properties above. This library
    // doesn't expose raw CCCD descriptor writes directly; subscribing is the
    // correct and only way to enable this at this API level.
    this.log('Subscribing to notifications on Control Point ...');
    const commandQueue: Uint8Array[] = [];
    let wake: (() => void) | null = null;

    const subscription: Subscription = connected.monitorCharacteristicForService(
      SERVICE_OTAP,
      CHAR_CONTROL_POINT,
      (error, characteristic) => {
        if (error) {
          this.log(`Monitor error: ${error.message}`);
          return;
        }
        if (characteristic?.value) {
          commandQueue.push(base64ToBytes(characteristic.value));
          if (wake) {
            wake();
            wake = null;
          }
        }
      },
    );

    const nextCommand = (): Promise<Uint8Array> => {
      if (commandQueue.length > 0) return Promise.resolve(commandQueue.shift()!);
      return new Promise((resolve) => {
        wake = () => resolve(commandQueue.shift()!);
      });
    };

    this.log('Handshake complete - waiting for MCU commands ...');

    try {
      // Step 8: dispatch loop
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const payload = await nextCommand();
        const cmd = payload[0];
        this.log(`Received command 0x${cmd.toString(16).padStart(2, '0').toUpperCase()} (${payload.length} bytes)`);

        if (cmd === CMD.NEW_IMAGE_INFO_REQUEST) {
          await connected.writeCharacteristicWithResponseForService(
            SERVICE_OTAP,
            CHAR_CONTROL_POINT,
            bytesToBase64(newImageInfoResponse(image, this.log)),
          );
          this.log('Sent New Image Info Response');
        } else if (cmd === CMD.IMAGE_BLOCK_REQUEST) {
          const req = parseBlockRequest(payload, this.log);
          await this.sendBlock(connected, req, image);
        } else if (cmd === CMD.IMAGE_TRANSFER_COMPLETE) {
          const ok = payload[3] === 0x00;
          this.log(`Transfer complete, status ${ok ? 'SUCCESS' : '0x' + payload[3].toString(16)}`);
          subscription.remove();
          await connected.cancelConnection();
          return ok;
        } else if (cmd === CMD.ERROR_NOTIFICATION || cmd === CMD.STOP_IMAGE_TRANSFER) {
          this.log(`MCU sent 0x${cmd.toString(16)} - aborting block`);
          this.abort = true;
        }
      }
    } finally {
      subscription.remove();
    }
  }

  /** Steps 9-11 (ATT method): slice the requested block into chunks. */
  private async sendBlock(device: Device, req: BlockRequest, image: OtapImage): Promise<void> {
    this.abort = false;
    if (req.method !== TRANSFER_ATT) {
      this.log('L2CAP requested but unsupported here - ignoring block');
      return;
    }

    // react-native-ble-plx doesn't expose the negotiated MTU directly by default;
    // 244 matches what the other reference implementations negotiated in practice.
    const maxMtuPayload = 244;
    const maxPayload = maxMtuPayload - 2;
    const chunkSize = Math.min(req.chunkSize, maxPayload);
    this.log(
      `Sending block -> start=${req.start}, block_size=${req.blockSize}, ` +
        `requested_chunk_size=${req.chunkSize}, max_mtu_write=${maxMtuPayload}, chunk_size_used=${chunkSize}`,
    );

    let sent = 0;
    let seq = 0;
    while (sent < req.blockSize && seq <= 255 && !this.abort) {
      const payload = image.range(req.start + sent, Math.min(chunkSize, req.blockSize - sent));
      await device.writeCharacteristicWithoutResponseForService(
        SERVICE_OTAP,
        CHAR_DATA,
        bytesToBase64(imageChunk(seq, payload)),
      );
      sent += payload.length;
      seq += 1;
      this.totalSent += payload.length;
      this.onProgress(Math.min(this.totalSent, image.size), image.size);

      // Pace the writes - firing "write without response" packets back-to-back
      // with no delay can overflow Android's internal BLE write queue, which
      // causes a silent disconnect (no JS-catchable error) once the buffer
      // fills up - typically around the same data volume every time. This
      // small pause gives the radio time to actually drain each packet.
      await new Promise((r) => setTimeout(r, 15));
    }
    const pct = (100 * Math.min(this.totalSent, image.size)) / image.size;
    this.log(`  ${this.totalSent}/${image.size} bytes (${pct.toFixed(1)} %)`);
  }

  /** Scans for a device advertising the given service UUID, mirroring BleakScanner.find_device_by_filter(). */
  private scanForDevice(serviceUuid: string, timeoutMs: number): Promise<Device | null> {
    return new Promise((resolve) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.manager.stopDeviceScan();
          resolve(null);
        }
      }, timeoutMs);

      this.manager.startDeviceScan([serviceUuid], null, (error, device) => {
        if (resolved) return;
        if (error) {
          resolved = true;
          clearTimeout(timer);
          this.manager.stopDeviceScan();
          this.log(`Scan error: ${error.message}`);
          resolve(null);
          return;
        }
        if (device) {
          resolved = true;
          clearTimeout(timer);
          this.manager.stopDeviceScan();
          resolve(device);
        }
      });
    });
  }
}