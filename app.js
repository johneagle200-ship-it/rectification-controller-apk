const SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const CHARACTERISTIC_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

let bluetoothDevice = null;
let rxCharacteristic = null;
let txCharacteristic = null;
let isExplicitDisconnect = false;
let reconnectTimer = null;

// 1. Инициализация при загрузке страницы
document.addEventListener("DOMContentLoaded", async () => {
  await checkSavedDevices();
});

// 2. Проверка ранее привязанных устройств и автоподключение
async function checkSavedDevices() {
  if (navigator.bluetooth && navigator.bluetooth.getDevices) {
    try {
      const devices = await navigator.bluetooth.getDevices();
      if (devices.length > 0) {
        bluetoothDevice = devices[0];
        document.getElementById('deviceName').innerText = bluetoothDevice.name || "ESP32_Autoclave";
        
        console.log("[BLE] Найдено запомненное устройство, пробуем подключиться...");
        // Автоматически подключаемся без вызова окна
        await bindAndConnect(bluetoothDevice);
      }
    } catch (err) {
      console.warn("[BLE] Автоподключение отклонено браузером (нужен клик):", err);
      updateUI("disconnected");
    }
  }
}

// 3. Главная точка входа для кнопки "Подключиться"
async function connectOrReconnect() {
  isExplicitDisconnect = false;
  clearTimeout(reconnectTimer);

  if (bluetoothDevice) {
    await bindAndConnect(bluetoothDevice);
  } else {
    await selectNewDevice();
  }
}

// 4. Выбор НОВОГО устройства (открывает системное диалоговое окно)
async function selectNewDevice() {
  try {
    isExplicitDisconnect = true; // Сбрасываем таймеры автореконнекта старого устройства
    clearTimeout(reconnectTimer);

    if (bluetoothDevice && bluetoothDevice.gatt.connected) {
      bluetoothDevice.gatt.disconnect();
    }

    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'ESP32' }],
      optionalServices: [SERVICE_UUID]
    });

    isExplicitDisconnect = false;
    document.getElementById('deviceName').innerText = bluetoothDevice.name || "ESP32_Autoclave";
    await bindAndConnect(bluetoothDevice);

  } catch (err) {
    console.log("[BLE] Выбор устройства отменён:", err);
    updateUI("disconnected");
  }
}

// 5. Установление GATT-сессии
async function bindAndConnect(device) {
  if (!device) return;

  try {
    clearTimeout(reconnectTimer);
    updateUI("connecting");
    
    device.removeEventListener('gattserverdisconnected', onDisconnected);
    device.addEventListener('gattserverdisconnected', onDisconnected);

    console.log("[BLE] Соединение с GATT...");
    const server = await device.gatt.connect();
    
    const service = await server.getPrimaryService(SERVICE_UUID);
    rxCharacteristic = await service.getCharacteristic(CHARACTERISTIC_RX_UUID);
    txCharacteristic = await service.getCharacteristic(CHARACTERISTIC_TX_UUID);

    await txCharacteristic.startNotifications();
    txCharacteristic.removeEventListener('characteristicvaluechanged', handleTelemetry);
    txCharacteristic.addEventListener('characteristicvaluechanged', handleTelemetry);

    updateUI("connected");
    console.log("[BLE] Успешно подключено!");

  } catch (err) {
    console.error("[BLE] Ошибка GATT:", err);
    
    if (!isExplicitDisconnect) {
      updateUI("reconnecting");
      scheduleReconnect(2000);
    } else {
      updateUI("disconnected");
    }
  }
}

// 6. Отключение по кнопке пользователя
function disconnectBLE() {
  isExplicitDisconnect = true;
  clearTimeout(reconnectTimer);

  if (bluetoothDevice && bluetoothDevice.gatt.connected) {
    bluetoothDevice.gatt.disconnect();
  }
  onDisconnected();
}

// 7. Обработчик потери связи
function onDisconnected() {
  rxCharacteristic = null;
  txCharacteristic = null;

  document.getElementById('tempCube').innerText = "-- °C";
  document.getElementById('pwr').innerText = "-- Вт";

  if (!isExplicitDisconnect && bluetoothDevice) {
    console.log("[BLE] Потеря связи. Ожидание восстановления...");
    updateUI("reconnecting");
    scheduleReconnect(3000);
  } else {
    updateUI("disconnected");
  }
}

// Планировщик повторных попыток без наслоения таймеров
function scheduleReconnect(delayMs) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!isExplicitDisconnect && bluetoothDevice) {
      bindAndConnect(bluetoothDevice);
    }
  }, delayMs);
}

// 8. Обновление интерфейса
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
  else if (state === "connecting") {
    statusEl.innerText = "Подключение...";
    statusEl.className = "status pending";
  }
  else if (state === "reconnecting") {
    statusEl.innerText = "Поиск ESP32...";
    statusEl.className = "status pending";
    btnConnect.style.display = "none";
    btnDisconnect.style.display = "inline-block"; // Даем возможность отменить поиск
  }
  else {
    statusEl.innerText = "Отключено";
    statusEl.className = "status";
    btnConnect.style.display = "inline-block";
    btnConnect.innerText = bluetoothDevice ? ("Подключить " + (bluetoothDevice.name || "ESP32")) : "Найти ESP32";
    btnDisconnect.style.display = "none";
  }
}

// Прием телеметрии
function handleTelemetry(event) {
  const decoder = new TextDecoder('utf-8');
  const jsonStr = decoder.decode(event.target.value);
  try {
    const data = JSON.parse(jsonStr);
    if (data.t_c !== undefined) document.getElementById('tempCube').innerText = data.t_c + " °C";
    if (data.pwr !== undefined) document.getElementById('pwr').innerText = data.pwr + " Вт";
  } catch (e) {
    console.log("Raw RX:", jsonStr);
  }
}

// Отправка команд
async function sendCmd(cmd) {
  if (!rxCharacteristic) {
    alert("Устройство не подключено!");
    return;
  }
  try {
    const encoder = new TextEncoder();
    await rxCharacteristic.writeValue(encoder.encode(cmd));
  } catch (e) {
    console.error("Ошибка отправки команды:", e);
  }
}
