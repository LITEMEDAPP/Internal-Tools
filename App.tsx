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
} from 'react-native';

import {BleManager, Device, Characteristic} from 'react-native-ble-plx';
import {pick} from '@react-native-documents/picker';
import {OtapImage, OtapServer, SERVICE_WU, CHAR_WU_WRITE, WU_OTA_TRIGGER_CMD, bytesToBase64} from './OtapServer';

const manager = new BleManager();

const TARGET_MAC  = '00:60:37:E2:85:4D';
const TARGET_NAME = 'LMNP-0000000000';
const COMMAND_HEX = '24 01 09 F6 00 96 7A 23';
const SubscribetoUUID = '01ff0101-ba5e-f4ee-5ca1-eb1e5e4b1ce0'

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

function App(): React.JSX.Element {

  const [targetDevice,  setTargetDevice]  = useState<Device | null>(null);
  const [scanning,      setScanning]      = useState(false);
  const [isConnected,   setIsConnected]   = useState(false);
  const [isConnecting,  setIsConnecting]  = useState(false);
  const [writableChars, setWritableChars] = useState<Characteristic[]>([]);
  const [logs,          setLogs]          = useState<string[]>([]);

  // ---- OTAP-specific state (new, added alongside the existing scanner) ----
  const [otapFileInfo, setOtapFileInfo] = useState<{name: string; imageId: number; size: number} | null>(null);
  const [otapProgress, setOtapProgress] = useState(0);
  const [otapRunning,  setOtapRunning]  = useState(false);
  const otapImageRef = useRef<OtapImage | null>(null);

  // ---- PostgreSQL upload-log tracking (new) ----
  // Holds the id of the firmware_uploads row created for the current/last update,
  // so we know which row to mark uploaded=true when the transfer finishes.
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

  // ─── SCAN ────────────────────────────────────────────────────────────────────

  const scanDevices = () => {
    setTargetDevice(null);
    setIsConnected(false);
    setWritableChars([]);
    setScanning(true);
    addLog('══ SCAN STARTED ══════════════════════');
    addLog(`Target MAC  : ${TARGET_MAC}`);
    addLog(`Target Name : ${TARGET_NAME}`);

    manager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        addLog(`SCAN ERROR : ${error.message}`);
        setScanning(false);
        return;
      }

      if (device) {
        addLog(`SCAN → ${device.name ?? 'Unknown'} | ${device.id} | RSSI: ${device.rssi} dBm`);
      }

      const matchedByMac  = device?.id   === TARGET_MAC;
      const matchedByName = device?.name === TARGET_NAME;

      if (matchedByMac || matchedByName) {
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

      connected.onDisconnected((error, device) => {
        addLog('══ DISCONNECTED ══════════════════════');
        if (error) addLog(`Reason : ${error.message}`);
        setIsConnected(false);
        setWritableChars([]);
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
      // onDisconnected() above handles resetting isConnected/writableChars/ref
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

    // --- PostgreSQL: log the start of this upload attempt ---
    try {
      const fileName = otapFileInfo?.name ?? 'unknown.bleota';
      const fileSize = otapFileInfo?.size ?? 0;
      const record = await createUploadRecord(fileName, fileSize);
      otapUploadRecordIdRef.current = record.id;
      addLog(`DB: created upload record id=${record.id} for ${fileName}`);
    } catch (dbErr: any) {
      // Don't block the actual OTA transfer if the DB/network call fails —
      // just log it and continue with the firmware update itself.
      addLog(`DB ERROR (create record): ${dbErr?.message}`);
      otapUploadRecordIdRef.current = null;
    }

    try {
      const server = new OtapServer({
        manager,
        image: otapImageRef.current,
        useWirelessUart: false, // trigger is the separate manual step above
        log: addLog,
        onProgress: (sent, total) => {
          setOtapProgress(total > 0 ? Math.round((sent * 100) / total) : 0);
        },
      });
      const ok = await server.run();
      addLog(ok ? 'OTAP: update complete.' : 'OTAP: update failed.');

      // --- PostgreSQL: mark the record uploaded=true only on success ---
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
  // Reuses the same already-loaded firmware image and re-runs the update from
  // scratch. The device tracks its own progress (per the OTAP spec, it can
  // request any block position at any time), so reconnecting and letting it
  // ask for whatever it still needs is the correct way to recover, rather than
  // needing to re-pick the file.

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
        <View style={{flexDirection: 'row', gap: 8, marginBottom: 12}}>
          <View style={{flex: 1}}>
            <Button
              title={scanning ? 'Scanning...' : 'Scan'}
              onPress={scanDevices}
              disabled={scanning || isConnected}
              color="#338e45"
            />
          </View>

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

        {/* Send Command buttons */}
        {writableChars.length > 0 && (
          <View style={{marginBottom: 12, gap: 6}}>
            {writableChars.map((char, i) => (
              <Button
                key={char.uuid}
                title={`Send Command → Char ${i + 1} [${char.uuid.slice(0,8)}...]`}
                onPress={() => sendCommand(char)}
              />
            ))}
          </View>
        )}

        {/* ── OTAP section (new, added alongside the existing scanner) ── */}
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
            disabled={otapRunning || !otapFileInfo}
            color="#8957e5"
          />

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

        {/* Log Panel (shared by both the scanner and OTAP flow) */}
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

export default App;