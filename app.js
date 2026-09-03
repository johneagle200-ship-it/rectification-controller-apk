// Безопасное получение BluetoothLe из Capacitor
const BluetoothLe = window.Capacitor?.Plugins?.BluetoothLe || (typeof Capacitor !== 'undefined' ? Capacitor.Plugins.BluetoothLe : null);

const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

let connectedDeviceId = null;
let isExplicitDisconnect = false;
let reconnectTimer = null;

// 1. Инициализация при старте приложения
document.addEventListener("DOMContentLoaded", async () => {
  try {
    if (!BluetoothLe) {
      console.error("[BLE Native] Плагин BluetoothLe не инициализирован");
      return;
    }

    // Инициализируем плагин и запрашиваем разрешения Android
    await BluetoothLe.initialize();
    await BluetoothLe.requestPermissions();
    console.log("[BLE Native] Плагин готов");

    // Подгружаем имя устройства из памяти, если оно за сохранено
    const savedName = localStorage.getItem("savedDeviceName");
    if (savedName) {
      document.getElementById('deviceName').innerText = savedName;
    }

    // Если устройство уже привязывалось — сразу подключаемся автоматически
    const savedId = localStorage.getItem("savedDeviceId");
    if (savedId) {
      connectedDeviceId = savedId;
      console.log("[BLE Native] Автоподключение к:", savedId);
      connectNativeBLE(savedId);
    }
  } catch (err) {
    console.error("[BLE Native] Ошибка инициализации:", err);
  }
});

// 2. Главный вызов по кнопке "Подключиться"
async function connectOrReconnect() {
  isExplicitDisconnect = false;
  clearTimeout(reconnectTimer);

  const savedId = localStorage.getItem("savedDeviceId");
  if (savedId) {
    connectNativeBLE(savedId);
  } else {
    selectNewDevice();
  }
}

// 3. Выбор нового устройства (системный поиск Android)
async function selectNewDevice() {
  try {
    isExplicitDisconnect = true;
    clearTimeout(reconnectTimer);

    updateUI("connecting");

    // Сканируем и выбираем ESP32
    const device = await BluetoothLe.requestDevice({
      services: [SERVICE_UUID],
      namePrefix: 'JE_'
    });

    if (device && device.deviceId) {
      connectedDeviceId = device.deviceId;
      const devName = device.name || "ESP32_Autoclave";

      localStorage.setItem("savedDeviceId", connectedDeviceId);
      localStorage.setItem("savedDeviceName", devName);
      document.getElementById('deviceName').innerText = devName;

      isExplicitDisconnect = false;
      connectNativeBLE(connectedDeviceId);
    }
  } catch (err) {
    console.log("[BLE Native] Выбор устройства отменен:", err);
    updateUI("disconnected");
  }
}

// 4. Прямое соединение к GATT без участия пользователя
async function connectNativeBLE(deviceId) {
  if (!deviceId) return;

  try {
    clearTimeout(reconnectTimer);
    updateUI("connecting");

    // Нативное подключение Android (работает в фоне!)
    await BluetoothLe.connect({ deviceId });
    console.log("[BLE Native] Подключено к GATT!");

    // Подписка на прием данных (TX)
    await BluetoothLe.startNotifications({
      deviceId,
      service: SERVICE_UUID,
      characteristic: CHARACTERISTIC_TX_UUID
    }, (result) => {
      handleTelemetry(result);
    });

    updateUI("connected");

  } catch (err) {
    console.error("[BLE Native] Ошибка соединения:", err);

    if (!isExplicitDisconnect) {
      updateUI("reconnecting");
      scheduleReconnect(3000);
    } else {
      updateUI("disconnected");
    }
  }
}

// 5. Отключение
async function disconnectBLE() {
  isExplicitDisconnect = true;
  clearTimeout(reconnectTimer);

  if (connectedDeviceId) {
    try {
      await BluetoothLe.disconnect({ deviceId: connectedDeviceId });
    } catch (e) {}
  }

  updateUI("disconnected");
}

// Таймер автоповтора
function scheduleReconnect(delayMs) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!isExplicitDisconnect && connectedDeviceId) {
      connectNativeBLE(connectedDeviceId);
    }
  }, delayMs);
}

// 6. Обновление UI
function updateUI(state) {
  const statusEl = document.getElementById('bleStatus');
  const btnConnect = document.getElementById('btnConnect');
  const btnDisconnect = document.getElementById('btnDisconnect');

  if (state === "connected") {
    statusEl.innerText = "Подключено";
    statusEl.className = "status connected";
    btnConnect.style.display = "none";
    btnDisconnect.style.display = "inline-block";
  } 
  else if (state === "connecting" || state === "reconnecting") {
    statusEl.innerText = state === "connecting" ? "Подключение..." : "Поиск ESP32...";
    statusEl.className = "status pending";
    btnConnect.style.display = "none";
    btnDisconnect.style.display = "inline-block";
  }
  else {
    statusEl.innerText = "Отключено";
    statusEl.className = "status";
    btnConnect.style.display = "inline-block";
    btnConnect.innerText = connectedDeviceId ? "Подключить ESP32" : "Найти ESP32";
    btnDisconnect.style.display = "none";
  }
}

// Прием данных
function handleTelemetry(result) {
  try {
    const rawVal = result.value || result;
    let bytes;

    if (rawVal instanceof DataView) {
      bytes = new Uint8Array(rawVal.buffer);
    } else if (rawVal.buffer) {
      bytes = new Uint8Array(rawVal.buffer);
    } else if (Array.isArray(rawVal)) {
      bytes = new Uint8Array(rawVal);
    } else {
      bytes = new Uint8Array(rawVal);
    }

    const jsonStr = new TextDecoder().decode(bytes);
    const data = JSON.parse(jsonStr);

    if (data.t_c !== undefined) document.getElementById('tempCube').innerText = data.t_c + " °C";
    if (data.pwr !== undefined) document.getElementById('pwr').innerText = data.pwr + " Вт";
  } catch (e) {
    // Игнорируем неполные кадры
  }
}

// Отправка команд
async function sendCmd(cmd) {
  if (!connectedDeviceId) {
    alert("Устройство не подключено!");
    return;
  }
  try {
    const encoder = new TextEncoder();
    const encoded = encoder.encode(cmd);
    const numbers = Array.from(encoded);

    await BluetoothLe.write({
      deviceId: connectedDeviceId,
      service: SERVICE_UUID,
      characteristic: CHARACTERISTIC_RX_UUID,
      value: numbers
    });
  } catch (e) {
    console.error("[BLE Native] Ошибка отправки:", e);
  }
}
