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

const manager = new BleManager();

const TARGET_MAC  = '00:60:37:7A:D3:11';
const TARGET_NAME = 'NXPMPD-0000';
const COMMAND_HEX = '24 01 09 F6 00 96 7A 23';

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

  const scrollRef = useRef<ScrollView>(null);

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

          // Subscribe to notifications/indications automatically
          if (char.isNotifiable || char.isIndicatable) {
            addLog(`│  🔔 Subscribing to notifications...`);
            char.monitor((error, update) => {
              if (error) {
                addLog(`NOTIFY ERROR [${char.uuid.slice(0,8)}...] : ${error.message}`);
                return;
              }
              if (update?.value) {
                const hex = base64ToHex(update.value);
                addLog(`◀ RX [${char.uuid.slice(0,8)}...] : ${hex}`);
              }
            });
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

  // ─── UI ──────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: '#fff'}}>
      <View style={{flex: 1, padding: 16}}>

        {/* Header */}
        <Text style={{fontSize: 16, fontWeight: 'bold', marginBottom: 12}}>
          BLE — {TARGET_NAME}
        </Text>

        {/* Controls */}
        <View style={{flexDirection: 'row', gap: 8, marginBottom: 12}}>
          <View style={{flex: 1}}>
            <Button
              title={scanning ? 'Scanning...' : 'Scan'}
              onPress={scanDevices}
              disabled={scanning || isConnected}
            />
          </View>

          {targetDevice && !isConnected && (
            <View style={{flex: 1}}>
              <Button
                title={isConnecting ? 'Connecting...' : 'Connect'}
                onPress={connectToDevice}
                disabled={isConnecting}
              />
            </View>
          )}

          {isConnected && (
            <View style={{flex: 1}}>
              <Text style={{
                textAlign: 'center',
                color: 'white',
                backgroundColor: '#2e7d32',
                padding: 8,
                borderRadius: 4,
              }}>
                Connected 🔗
              </Text>
            </View>
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

        {/* Log Panel */}
        <View style={{
          flex: 1,
          backgroundColor: '#0d0d0d',
          borderRadius: 8,
          padding: 8,
        }}>
          <View style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginBottom: 4,
          }}>
            <Text style={{color: '#00ff88', fontSize: 11}}>LOG</Text>
            <Text
              style={{color: '#ff4444', fontSize: 11}}
              onPress={clearLogs}>
              CLEAR
            </Text>
          </View>

          <ScrollView ref={scrollRef} showsVerticalScrollIndicator={false}>
            {logs.map((line, i) => (
              <Text key={i} style={{
                color: line.includes('ERROR')       ? '#ff4444'
                     : line.includes('══')          ? '#00ff88'
                     : line.includes('◀ RX')        ? '#00cfff'
                     : line.includes('▶ TX')        ? '#ffcc00'
                     : line.includes('✅')          ? '#88ff88'
                     : line.includes('🔔')          ? '#cc88ff'
                     : '#cccccc',
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