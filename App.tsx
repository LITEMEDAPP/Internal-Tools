import { createUploadRecord, markUploadComplete, fetchUploads } from './api/uploadsApi';
import React, {useEffect, useState, useRef} from 'react';
import {
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  Button,
  Text,
  View,
  ScrollView,
  Image,
  TouchableOpacity,
} from 'react-native';

import {BleManager, Device, Characteristic} from 'react-native-ble-plx';
import {pick} from '@react-native-documents/picker';
import {OtapImage, OtapServer, SERVICE_WU, CHAR_WU_WRITE, WU_OTA_TRIGGER_CMD, bytesToBase64, base64ToBytes} from './OtapServer';

const manager = new BleManager();

// ─── KNOWN TARGET DEVICES (quick-scan) ──────────────────────────────────────
const TARGET_DEVICES = [
  { mac: '00:60:37:E2:85:4D', name: 'LMNP-0000000000' },
  { mac: '00:60:37:67:5A:C8', name: 'LMNP-9999999999' },
];

// ─── GENERIC OTA DEVICE DETECTION (nearby-scan) ─────────────────────────────
// The device is confirmed to advertise SERVICE_WU in its advertisement
// packet. We scan unfiltered and match on EITHER signal - the advertised
// SERVICE_WU UUID (when the OS surfaces it in device.serviceUUIDs) OR the
// "LMNP-" name prefix - so a device is picked up even if one of those two
// signals happens to be missing from a given advertisement packet.
const OTA_DEVICE_NAME_PREFIX = 'LMNP-';
const OTA_DEVICE_NAME_PREFIX_2 = 'LMMP-';
const NEARBY_SCAN_DURATION_MS = 6000;

const COMMAND_HEX = '24 01 09 F6 00 96 7A 23';
const SubscribetoUUID = '01ff0101-ba5e-f4ee-5ca1-eb1e5e4b1ce0'

// ─── HARDWARE COMPATIBILITY CHECK ────────────────────────────────────────────
// Sent to CHAR_WU_WRITE right after connecting. The device responds (via
// notify/indicate on the same characteristic) with a frame whose 5th byte
// (index 4) encodes the hardware revision. OTA is only supported on hardware
// revision 3 or higher.
const HARDWARE_CHECK_CMD = new Uint8Array([0x24, 0x01, 0x15, 0xea, 0x00, 0x5f, 0x7c, 0x23]);
const HARDWARE_REV_BYTE_INDEX = 4;
const MIN_OTA_HARDWARE_REV = 3;
const HARDWARE_CHECK_TIMEOUT_MS = 5000;

async function requestPermissions() {
  if (Platform.OS === 'android') {
    await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
  }
}

const hexToBase64 = (hex: string): string => {
  const bytes = hex.replace(/\s/g, '')
                   .match(/.{1,2}/g)!
                   .map(b => parseInt(b, 16));
  return btoa(String.fromCharCode(...bytes));
};

const base64ToHex = (b64: string): string => {
  const binary = atob(b64);
  return Array.from(binary)
    .map(c => c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
};

const timestamp = () => {
  const d = new Date();
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}.${d.getMilliseconds().toString().padStart(3,'0')}`;
};

// ─── SPLASH SCREEN ──────────────────────────────────────────────────────────

const SPLASH_MIN_DURATION_MS = 1000;

function SplashScreen(): React.JSX.Element {
  return (
    <View style={{
      flex: 1,
      backgroundColor: '#121417',
      justifyContent: 'center',
      alignItems: 'center',
    }}>
      <Image
        source={require('./assets/curapod_logo.png')}
        style={{ width: 240, height: 60, resizeMode: 'contain' }}
      />
      <Text style={{
        fontSize: 12,
        letterSpacing: 3,
        color: '#8957e5',
        textTransform: 'uppercase',
        marginTop: 10,
      }}>
        OTAP
      </Text>
    </View>
  );
}

function MainApp(): React.JSX.Element {

  const [targetDevice,  setTargetDevice]  = useState<Device | null>(null);
  const [scanning,      setScanning]      = useState(false);
  const [isConnected,   setIsConnected]   = useState(false);
  const [isConnecting,  setIsConnecting]  = useState(false);
  const [writableChars, setWritableChars] = useState<Characteristic[]>([]);
  const [logs,          setLogs]          = useState<string[]>([]);

  // ---- Nearby OTA device discovery (new) ----
  const [nearbyDevices,   setNearbyDevices]   = useState<Device[]>([]);
  const [scanningNearby,  setScanningNearby]  = useState(false);
  const nearbyDeviceIdsRef = useRef<Set<string>>(new Set());

  // ---- Hardware compatibility check (new) ----
  // Runs automatically right after connecting. 'idle' before any check has
  // run, 'checking' while waiting for the device's response, then settles
  // into 'compatible' / 'incompatible' / 'error'.
  const [hardwareCheckStatus, setHardwareCheckStatus] = useState<
    'idle' | 'checking' | 'compatible' | 'incompatible' | 'error'
  >('idle');
  const [hardwareRevision, setHardwareRevision] = useState<number | null>(null);

  // ---- OTAP-specific state ----
  const [otapFileInfo, setOtapFileInfo] = useState<{name: string; imageId: number; size: number} | null>(null);
  const [otapProgress, setOtapProgress] = useState(0);
  const [otapRunning,  setOtapRunning]  = useState(false);
  const otapImageRef = useRef<OtapImage | null>(null);

  // ---- PostgreSQL upload-log tracking ----
  const otapUploadRecordIdRef = useRef<number | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const connectedDeviceRef = useRef<Device | null>(null);

  useEffect(() => {
    requestPermissions();
    return () => {
      manager.stopDeviceScan();
      manager.destroy();
    };
  }, []);

  const addLog = (message: string) => {
    const line = `[${timestamp()}] ${message}`;
    console.log(line);
    setLogs(prev => [...prev, line]);
    setTimeout(() => scrollRef.current?.scrollToEnd({animated: true}), 100);
  };

  const clearLogs = () => setLogs([]);

  // ─── QUICK SCAN (known target devices) ──────────────────────────────────────

  const scanDevices = () => {
    setTargetDevice(null);
    setIsConnected(false);
    setWritableChars([]);
    setScanning(true);
    addLog('══ QUICK SCAN STARTED ════════════════');
    TARGET_DEVICES.forEach(d => addLog(`Target: ${d.name} (${d.mac})`));

    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        addLog(`SCAN ERROR : ${error.message}`);
        setScanning(false);
        return;
      }

      if (device) {
        addLog(`SCAN → ${device.name ?? 'Unknown'} | ${device.id} | RSSI: ${device.rssi} dBm`);
      }

      const matched = TARGET_DEVICES.some(
        d => device?.id === d.mac || device?.name === d.name
      );

      if (matched) {
        addLog(`══ TARGET FOUND ══════════════════════`);
        addLog(`Name : ${device?.name}`);
        addLog(`MAC  : ${device?.id}`);
        addLog(`RSSI : ${device?.rssi} dBm`);
        manager.stopDeviceScan();
        setScanning(false);
        setTargetDevice(device);
        addLog('══ SCAN STOPPED ══════════════════════');
      }
    });

    setTimeout(() => {
      manager.stopDeviceScan();
      setScanning(false);
      addLog('══ SCAN TIMEOUT — device not found ══');
    }, 5000);
  };

  // ─── NEARBY SCAN (any device matching the LMNP- name pattern) ───────────────
  // Unlike scanDevices() above, this does not stop at the first match — it
  // keeps listening for NEARBY_SCAN_DURATION_MS and collects every distinct
  // OTA-capable device it sees, so the user can pick one from a list rather
  // than needing to know its MAC/name ahead of time.

  const scanNearbyOtaDevices = () => {
    setNearbyDevices([]);
    nearbyDeviceIdsRef.current = new Set();
    setTargetDevice(null);
    setIsConnected(false);
    setWritableChars([]);
    setScanningNearby(true);
    addLog('══ NEARBY OTA SCAN STARTED ═══════════');
    addLog(`Matching by name "${OTA_DEVICE_NAME_PREFIX}*" or "${OTA_DEVICE_NAME_PREFIX_2}*" OR service UUID ${SERVICE_WU}`);

    // Scan unfiltered so we see every device's raw advertisement, then match
    // on EITHER the SERVICE_WU UUID (when present in device.serviceUUIDs) or
    // the LMNP- name prefix - covers cases where either signal alone might
    // be missing from a particular advertisement packet.
    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        addLog(`NEARBY SCAN ERROR : ${error.message}`);
        setScanningNearby(false);
        return;
      }

      if (!device || nearbyDeviceIdsRef.current.has(device.id)) {
        return; // no device data, or already collected this one
      }

      const matchesName = !!(
        device.name?.startsWith(OTA_DEVICE_NAME_PREFIX) ||
        device.name?.startsWith(OTA_DEVICE_NAME_PREFIX_2)
      );
      const matchesUuid = !!device.serviceUUIDs?.some(
        u => u.toLowerCase() === SERVICE_WU.toLowerCase()
      );

      if (!matchesName && !matchesUuid) {
        return; // doesn't match either signal, ignore
      }

      nearbyDeviceIdsRef.current.add(device.id);
      addLog(`OTA DEVICE FOUND → ${device.name ?? 'Unknown'} | ${device.id} | RSSI: ${device.rssi} dBm | matched by: ${matchesName ? 'name' : ''}${matchesName && matchesUuid ? ' + ' : ''}${matchesUuid ? 'uuid' : ''}`);
      setNearbyDevices(prev => [...prev, device]);
    });

    setTimeout(() => {
      manager.stopDeviceScan();
      setScanningNearby(false);
      addLog(`══ NEARBY SCAN COMPLETE (${nearbyDeviceIdsRef.current.size} found) ══`);
    }, NEARBY_SCAN_DURATION_MS);
  };

  const selectNearbyDevice = (device: Device) => {
    setTargetDevice(device);
    addLog(`══ SELECTED: ${device.name} (${device.id}) ══`);
  };

  // ─── HARDWARE COMPATIBILITY CHECK ────────────────────────────────────────────
  // Writes HARDWARE_CHECK_CMD to CHAR_WU_WRITE, then waits for the device's
  // response on the same characteristic (via notify/indicate). The 5th byte
  // (index 4) of the response encodes the hardware revision; OTA is only
  // supported when that revision is 3 or higher.

  const runHardwareCompatibilityCheck = async (device: Device) => {
    setHardwareCheckStatus('checking');
    setHardwareRevision(null);
    addLog('══ HARDWARE CHECK STARTED ═════════════');

    let subscription: any = null;

    try {
      const responseBytes: Uint8Array = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Timed out waiting for hardware check response'));
        }, HARDWARE_CHECK_TIMEOUT_MS);

        subscription = device.monitorCharacteristicForService(
          SERVICE_WU,
          CHAR_WU_WRITE,
          (error, characteristic) => {
            if (error) {
              clearTimeout(timer);
              reject(error);
              return;
            }
            if (characteristic?.value) {
              clearTimeout(timer);
              resolve(base64ToBytes(characteristic.value));
            }
          },
        );

        device
          .writeCharacteristicWithoutResponseForService(
            SERVICE_WU,
            CHAR_WU_WRITE,
            bytesToBase64(HARDWARE_CHECK_CMD),
          )
          .then(() => {
            addLog(
              `Sent hardware check command: ${Array.from(HARDWARE_CHECK_CMD)
                .map(b => b.toString(16).padStart(2, '0'))
                .join(' ')}`,
            );
          })
          .catch(err => {
            clearTimeout(timer);
            reject(err);
          });
      });

      addLog(
        `Hardware check response: ${Array.from(responseBytes)
          .map(b => b.toString(16).padStart(2, '0'))
          .join(' ')}`,
      );

      if (responseBytes.length <= HARDWARE_REV_BYTE_INDEX) {
        throw new Error(`Response too short (${responseBytes.length} bytes) to read hardware revision`);
      }

      const revision = responseBytes[HARDWARE_REV_BYTE_INDEX];
      setHardwareRevision(revision);

      if (revision >= MIN_OTA_HARDWARE_REV) {
        setHardwareCheckStatus('compatible');
        addLog(`══ HARDWARE REV ${revision} — OTA SUPPORTED ══`);
      } else {
        setHardwareCheckStatus('incompatible');
        addLog(`══ HARDWARE REV ${revision} — OTA NOT SUPPORTED (needs >= ${MIN_OTA_HARDWARE_REV}) ══`);
      }
    } catch (err: any) {
      setHardwareCheckStatus('error');
      addLog(`HARDWARE CHECK ERROR : ${err?.message}`);
    } finally {
      subscription?.remove();
    }
  };

  // ─── CONNECT + DISCOVER ──────────────────────────────────────────────────────

  const connectToDevice = async () => {
    if (!targetDevice) return;

    try {
      setIsConnecting(true);
      addLog('══ CONNECTING ════════════════════════');
      addLog(`Device : ${targetDevice.id}`);

      const connected = await targetDevice.connect();
      connectedDeviceRef.current = connected;
      addLog('Connected — discovering services...');

      await connected.discoverAllServicesAndCharacteristics();
      addLog('Discovery complete');

      const services = await connected.services();
      addLog(`══ SERVICES (${services.length}) ═══════════════════`);

      const found: Characteristic[] = [];

      for (const service of services) {
        addLog(`┌ SERVICE : ${service.uuid}`);
        const chars = await service.characteristics();

        for (const char of chars) {
          const props = [
            char.isReadable               ? 'READ'              : '',
            char.isWritableWithResponse   ? 'WRITE'             : '',
            char.isWritableWithoutResponse? 'WRITE_NO_RESP'     : '',
            char.isNotifiable             ? 'NOTIFY'            : '',
            char.isIndicatable            ? 'INDICATE'          : '',
          ].filter(Boolean).join(' | ');

          addLog(`│  CHAR : ${char.uuid}`);
          addLog(`│  PROPS: ${props || 'none'}`);

          if (char.isWritableWithResponse || char.isWritableWithoutResponse) {
            found.push(char);
            addLog(`│  ✅ Added to writable list`);
          }
        }
        addLog(`└─────────────────────────────────────`);
      }

      addLog(`══ WRITABLE CHARS FOUND: ${found.length} ═══════`);
      setWritableChars(found);
      setIsConnected(true);
      setIsConnecting(false);

      // Run the hardware compatibility check automatically, right after
      // connecting - not awaited here so it doesn't delay the rest of the
      // connect flow; it updates hardwareCheckStatus in the background.
      runHardwareCompatibilityCheck(connected);

      connected.onDisconnected((error, device) => {
        addLog('══ DISCONNECTED ══════════════════════');
        if (error) addLog(`Reason : ${error.message}`);
        setIsConnected(false);
        setWritableChars([]);
        setHardwareCheckStatus('idle');
        setHardwareRevision(null);
        connectedDeviceRef.current = null;
      });

    } catch (error: any) {
      addLog(`CONNECTION ERROR : ${error.message}`);
      setIsConnecting(false);
      setIsConnected(false);
    }
  };

  // ─── SEND COMMAND ────────────────────────────────────────────────────────────

  const sendCommand = async (char: Characteristic) => {
    try {
      const base64 = hexToBase64(COMMAND_HEX);
      addLog(`══ SEND COMMAND ══════════════════════`);
      addLog(`▶ TX [${char.uuid.slice(0,8)}...] : ${COMMAND_HEX}`);

      if (char.isWritableWithResponse) {
        await char.writeWithResponse(base64);
        addLog(`Write with response — OK`);
      } else {
        await char.writeWithoutResponse(base64);
        addLog(`Write without response — OK`);
      }
    } catch (error: any) {
      addLog(`WRITE ERROR : ${error.message}`);
    }
  };

  // ─── DISCONNECT ──────────────────────────────────────────────────────────────

  const disconnectDevice = async () => {
    try {
      addLog('══ DISCONNECTING ══════════════════════');
      await connectedDeviceRef.current?.cancelConnection();
    } catch (error: any) {
      addLog(`DISCONNECT ERROR : ${error.message}`);
    }
  };

  // ─── OTAP: pick firmware file ────────────────────────────────────────────────

  const pickOtapFile = async () => {
    try {
      const [result] = await pick({mode: 'open'});
      if (!result) {
        return;
      }
      if (!result.name?.toLowerCase().endsWith('.bleota')) {
        addLog(`OTAP: rejected file '${result.name}' - only .bleota files are accepted`);
        return;
      }
      const response = await fetch(result.uri);
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const image = new OtapImage(bytes, addLog);
      otapImageRef.current = image;
      setOtapFileInfo({name: result.name, imageId: image.imageId, size: image.size});
      addLog(`OTAP: firmware file parsed OK: ${result.name} imageId=${image.imageId} size=${image.size}`);
    } catch (err: any) {
      if (err?.message !== 'User canceled document picker') {
        addLog(`OTAP: failed to load firmware file: ${err?.message}`);
      }
    }
  };

  // ─── OTAP: trigger OTA mode via Wireless UART ───────────────────────────────

  const runOtapTrigger = async () => {
    const device = connectedDeviceRef.current;
    if (!device) {
      addLog('OTAP: not connected - use Scan + Connect above first, then Trigger.');
      return;
    }
    setOtapRunning(true);
    addLog('══ OTAP: TRIGGER OTA MODE ════════════');
    try {
      addLog(`Writing OTA trigger command to WU characteristic: ${WU_OTA_TRIGGER_CMD.reduce((s, b) => s + b.toString(16).padStart(2, '0') + ' ', '').trim()}`);
      await device.writeCharacteristicWithoutResponseForService(
        SERVICE_WU,
        CHAR_WU_WRITE,
        bytesToBase64(WU_OTA_TRIGGER_CMD),
      );
      addLog('OTAP: trigger sent - device should reboot into OTA mode.');
    } catch (err: any) {
      addLog(`OTAP ERROR : ${err?.message}`);
    } finally {
      setOtapRunning(false);
    }
  };

  // ─── OTAP: run the firmware transfer ─────────────────────────────────────────

  const runOtapUpdate = async () => {
    if (!otapImageRef.current) {
      addLog('OTAP: no firmware file loaded');
      return;
    }
    setOtapRunning(true);
    setOtapProgress(0);
    addLog('══ OTAP: START FIRMWARE UPDATE ═══════');

    try {
      const fileName = otapFileInfo?.name ?? 'unknown.bleota';
      const fileSize = otapFileInfo?.size ?? 0;
      const deviceUuid = connectedDeviceRef.current?.id;
      const record = await createUploadRecord(fileName, fileSize, deviceUuid);
      otapUploadRecordIdRef.current = record.id;
      addLog(`DB: created upload record id=${record.id} for ${fileName}`);
    } catch (dbErr: any) {
      addLog(`DB ERROR (create record): ${dbErr?.message}`);
      otapUploadRecordIdRef.current = null;
    }

    try {
      const server = new OtapServer({
        manager,
        image: otapImageRef.current,
        useWirelessUart: false,
        log: addLog,
        onProgress: (sent, total) => {
          setOtapProgress(total > 0 ? Math.round((sent * 100) / total) : 0);
        },
      });
      const ok = await server.run();
      addLog(ok ? 'OTAP: update complete.' : 'OTAP: update failed.');

      if (ok && otapUploadRecordIdRef.current !== null) {
        try {
          await markUploadComplete(otapUploadRecordIdRef.current);
          addLog(`DB: marked record id=${otapUploadRecordIdRef.current} as uploaded`);
        } catch (dbErr: any) {
          addLog(`DB ERROR (mark complete): ${dbErr?.message}`);
        }
      }
    } catch (err: any) {
      addLog(`OTAP ERROR : ${err?.message}`);
    } finally {
      setOtapRunning(false);
    }
  };

  // ─── OTAP: refresh/retry after a mid-transfer disconnect ────────────────────

  const runOtapRefresh = async () => {
    addLog('══ OTAP: REFRESHING UPDATE (retry after disconnect) ══');
    await runOtapUpdate();
  };

  // ─── UI ──────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: '#121417'}}>
      <View style={{flex: 1, padding: 16}}>

        {/* Header */}
        <View style={{marginBottom: 12}}>
          <Text style={{fontSize: 17, fontWeight: '500', letterSpacing: 3, color: '#e6edf3', textTransform: 'uppercase'}}>
            Curapod
          </Text>
          <Text style={{fontSize: 9, letterSpacing: 2, color: '#8b949e', textTransform: 'uppercase', marginTop: 2}}>
            OTA Server
          </Text>
        </View>

        {/* Controls */}
        <View style={{flexDirection: 'row', gap: 8, marginBottom: 8}}>
          {targetDevice && !isConnected && (
            <View style={{flex: 1}}>
              <Button
                title={isConnecting ? 'Connecting...' : 'Connect'}
                onPress={connectToDevice}
                disabled={isConnecting}
                color="#238636"
              />
            </View>
          )}

          {isConnected && (
            <>
              <View style={{flex: 1}}>
                <Text style={{
                  textAlign: 'center',
                  color: 'white',
                  backgroundColor: '#238636',
                  padding: 8,
                  borderRadius: 4,
                }}>
                  Connected 🔗
                </Text>
              </View>
              <View style={{flex: 1}}>
                <Button title="Disconnect" onPress={disconnectDevice} color="#c62828" />
              </View>
            </>
          )}
        </View>

        {/* Hardware compatibility check status */}
        {isConnected && hardwareCheckStatus !== 'idle' && (
          <View style={{
            marginBottom: 12,
            padding: 8,
            borderRadius: 6,
            backgroundColor:
              hardwareCheckStatus === 'checking'      ? '#1c2128'
              : hardwareCheckStatus === 'compatible'   ? '#238636'
              : hardwareCheckStatus === 'incompatible' ? '#c62828'
              : '#8b3a3a',
          }}>
            <Text style={{color: 'white', fontSize: 12, fontWeight: '600', textAlign: 'center'}}>
              {hardwareCheckStatus === 'checking' && 'Checking device hardware...'}
              {hardwareCheckStatus === 'compatible' && `✅ Hardware Rev ${hardwareRevision} — OTA Supported`}
              {hardwareCheckStatus === 'incompatible' && `⛔ Hardware Rev ${hardwareRevision} — OTA Not Supported`}
              {hardwareCheckStatus === 'error' && '⚠️ Hardware check failed'}
            </Text>
          </View>
        )}

        {/* Nearby OTA device scan */}
        {!isConnected && (
          <View style={{marginBottom: 12}}>
            <Button
              title={scanningNearby ? 'Scanning nearby...' : '📡 Scan Nearby OTA Devices'}
              onPress={scanNearbyOtaDevices}
              disabled={scanning || scanningNearby}
              color="#238636"
            />

            {nearbyDevices.length > 0 && (
              <View style={{
                marginTop: 8,
                borderWidth: 1,
                borderColor: '#30363d',
                borderRadius: 8,
                backgroundColor: '#1c2128',
                padding: 8,
                gap: 6,
              }}>
                <Text style={{fontSize: 11, color: '#8b949e', marginBottom: 2}}>
                  {nearbyDevices.length} OTA device(s) found (by service UUID) — tap to select:
                </Text>
                {nearbyDevices.map(device => (
                  <TouchableOpacity
                    key={device.id}
                    onPress={() => selectNearbyDevice(device)}
                    style={{
                      padding: 8,
                      borderRadius: 6,
                      backgroundColor: targetDevice?.id === device.id ? '#8957e5' : '#010409',
                      borderWidth: 1,
                      borderColor: targetDevice?.id === device.id ? '#8957e5' : '#30363d',
                    }}
                  >
                    <Text style={{color: '#e6edf3', fontSize: 12, fontWeight: '600'}}>
                      {device.name}
                    </Text>
                    <Text style={{color: '#8b949e', fontSize: 10}}>
                      {device.id} · RSSI {device.rssi} dBm
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        {/* OTAP section */}
        <View style={{
          marginBottom: 12,
          padding: 10,
          borderWidth: 1,
          borderColor: '#30363d',
          borderRadius: 8,
          backgroundColor: '#1c2128',
          gap: 6,
        }}>
          <Text style={{fontSize: 12, fontWeight: 'bold', color: '#8b949e', marginBottom: 2}}>
            OTAP FIRMWARE UPDATE
          </Text>

          <Button
            title="1. Trigger OTA Mode (WU)"
            onPress={runOtapTrigger}
            disabled={otapRunning}
            color="#1f6d74"
          />

          <Button
            title="2. Pick Firmware File (.bleota)"
            onPress={pickOtapFile}
            disabled={otapRunning}
            color="#1f6d74"
          />
          {otapFileInfo && (
            <Text style={{fontSize: 11, color: '#8b949e'}}>
              Loaded: {otapFileInfo.name} — imageId={otapFileInfo.imageId}, size={otapFileInfo.size} bytes
            </Text>
          )}

          <Button
            title="3. Start Firmware Update (OTAP)"
            onPress={runOtapUpdate}
            disabled={otapRunning || !otapFileInfo || hardwareCheckStatus === 'incompatible'}
            color="#8957e5"
          />
          {hardwareCheckStatus === 'incompatible' && (
            <Text style={{fontSize: 10, color: '#f85149'}}>
              Update disabled: this device's hardware revision does not support OTA.
            </Text>
          )}

          <Button
            title="🔄 Refresh Update (retry after disconnect)"
            onPress={runOtapRefresh}
            disabled={otapRunning || !otapFileInfo}  
            color="#d97706"
          />

          <View style={{height: 6, backgroundColor: '#30363d', borderRadius: 3, overflow: 'hidden'}}>
            <View style={{height: '100%', width: `${otapProgress}%`, backgroundColor: '#8957e5'}} />
          </View>
          <Text style={{fontSize: 11, color: '#8b949e'}}>{otapProgress}%</Text>
        </View>

        {/* Log Panel */}
        <View style={{
          flex: 1,
          backgroundColor: '#010409',
          borderRadius: 8,
          padding: 8,
        }}>
          <View style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginBottom: 4,
          }}>
            <Text style={{color: '#3fb950', fontSize: 11}}>LOG</Text>
            <Text
              style={{color: '#f85149', fontSize: 11}}
              onPress={clearLogs}>
              CLEAR
            </Text>
          </View>

          <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false}>
            {logs.map((line, i) => (
              <Text key={i} style={{
                color: line.includes('ERROR')       ? '#f85149'
                     : line.includes('══')          ? '#3fb950'
                     : line.includes('◀ RX')        ? '#00cfff'
                     : line.includes('▶ TX')        ? '#ffcc00'
                     : line.includes('✅')          ? '#88ff88'
                     : line.includes('🔔')          ? '#a371f7' 
                     : '#8b949e',
                fontSize: 10,
                fontFamily: 'monospace',
                marginBottom: 1,
              }}>
                {line}
              </Text>
            ))}
          </ScrollView>
        </View>

      </View>
    </SafeAreaView>
  );
}

// ─── ROOT APP: shows splash for at least SPLASH_MIN_DURATION_MS, then MainApp ──

function App(): React.JSX.Element {
  const [showSplash, setShowSplash] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), SPLASH_MIN_DURATION_MS);
    return () => clearTimeout(timer);
  }, []);

  if (showSplash) {
    return <SplashScreen />;
  }

  return <MainApp />;
}

export default App;