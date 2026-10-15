(() => {
  'use strict';

  const root = document.documentElement;
  let themeToggle;
  let themeIcon;
  const isSimulation = Boolean(document.getElementById('page-simulation'));
  const chartWindowSeconds = 60;
  let THREE = null;
  let OrbitControls = null;
  let threeDependencyPromise = null;
  let latestChartTimestamp = null;
  const thermalColorStops = [
    { temperature: 20, color: '#3b82f6' },
    { temperature: 35, color: '#10b981' },
    { temperature: 50, color: '#ef4444' },
  ];
  let temperatureChart;
  let coolingChart;
  let socket;
  let reconnectTimer;
  let reconnectDelay = 1000;
  let frameCount = 0;
  let lastFpsSample = performance.now();
  let lastTelemetryAt = 0;
  let resizeSimulationRenderer = () => {};
  let routerInitialized = false;
  const sceneInstances = new Map();

  function byId(id) { return document.getElementById(id); }
  function setText(id, text) { const element = byId(id); if (element) element.textContent = text; }

  function thermalColorForTemperature(temperature, target) {
    if (!THREE) return null;
    const colorTarget = target || new THREE.Color();
    if (!Number.isFinite(Number(temperature))) return colorTarget.set('#7891a2');
    const value = Number(temperature);
    if (value <= thermalColorStops[0].temperature) return colorTarget.set(thermalColorStops[0].color);
    const last = thermalColorStops[thermalColorStops.length - 1];
    if (value >= last.temperature) return colorTarget.set(last.color);
    for (let index = 0; index < thermalColorStops.length - 1; index += 1) {
      const lower = thermalColorStops[index];
      const upper = thermalColorStops[index + 1];
      if (value <= upper.temperature) {
        const blend = (value - lower.temperature) / (upper.temperature - lower.temperature);
        return colorTarget.set(lower.color).lerp(new THREE.Color(upper.color), blend);
      }
    }
    return colorTarget.set(last.color);
  }

  function loadThreeDependencies() {
    if (THREE && OrbitControls) return Promise.resolve(true);
    if (!threeDependencyPromise) {
      threeDependencyPromise = Promise.all([
        import('three'),
        import('three/addons/controls/OrbitControls.js'),
      ]).then(([threeModule, controlsModule]) => {
        THREE = threeModule;
        OrbitControls = controlsModule.OrbitControls;
        window.THREE = THREE;
        window.OrbitControls = OrbitControls;
        return true;
      }).catch(() => {
        threeDependencyPromise = null;
        return false;
      });
    }
    return threeDependencyPromise;
  }

  function setHoverTooltipReading(instance, cellIndex) {
    const cell = instance.cells[cellIndex];
    if (!cell || !instance.tooltip) return;
    const cellId = String(cellIndex + 1).padStart(2, '0');
    setText('cell-hover-id', `Cell #${cellId}`);
    setText('cell-hover-temperature', Number.isFinite(cell.userData.temperature) ? `${cell.userData.temperature.toFixed(1)} °C` : 'Temperature unavailable');
  }

  function setTheme(theme) {
    root.dataset.theme = theme;
    const dark = theme === 'dark';
    if (themeIcon) themeIcon.textContent = dark ? '☀' : '☾';
    if (themeToggle) {
      themeToggle.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
      themeToggle.title = `Switch to ${dark ? 'light' : 'dark'} mode`;
    }
    try { localStorage.setItem('ggthermalsync-theme', theme); } catch (_) { /* storage may be disabled */ }
    refreshChartTheme();
  }

  function initTheme() {
    themeToggle = document.querySelector('.theme-toggle');
    themeIcon = document.querySelector('.theme-icon');
    let savedTheme = 'light';
    try { savedTheme = localStorage.getItem('ggthermalsync-theme') || 'light'; } catch (_) { /* storage may be disabled */ }
    setTheme(savedTheme === 'dark' ? 'dark' : 'light');
    themeToggle?.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));
  }

  function chartOptions(kind) {
    const dark = root.dataset.theme === 'dark';
    const color = dark ? '#a6b3c4' : '#667386';
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: dark ? '#11161c' : '#1d2430',
          titleFont: { family: 'IBM Plex Mono, monospace', size: 9 },
          bodyFont: { family: 'IBM Plex Mono, monospace', size: 10 },
          padding: 8,
          displayColors: false,
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: latestChartTimestamp === null ? 0 : latestChartTimestamp - chartWindowSeconds,
          max: latestChartTimestamp === null ? chartWindowSeconds : latestChartTimestamp,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color,
            maxTicksLimit: 4,
            maxRotation: 0,
            padding: 2,
            font: { family: 'IBM Plex Mono, monospace', size: 7 },
            callback: (value) => {
              if (latestChartTimestamp === null) return '';
              const offset = Math.round(Number(value) - latestChartTimestamp);
              return offset === 0 ? 'now' : `${offset}s`;
            },
          },
        },
        y: {
          min: kind === 'cooling' ? 0 : 20,
          max: kind === 'cooling' ? 100 : 50,
          grid: { color: dark ? 'rgba(226,235,247,.10)' : 'rgba(29,36,48,.09)', drawTicks: false },
          border: { display: false, dash: [3, 4] },
          ticks: { color, maxTicksLimit: 4, padding: 5, font: { family: 'IBM Plex Mono, monospace', size: 8 }, callback: (value) => kind === 'cooling' ? `${value}%` : `${value}°` },
        },
      },
    };
  }

  function createCharts() {
    if (!isSimulation || !window.Chart) return;
    if (temperatureChart && coolingChart) return { temperatureChart, coolingChart };
    if (!byId('chart-canvas') || !byId('cooling-chart')) return;
    temperatureChart = new Chart(byId('chart-canvas'), {
      type: 'line',
      data: { datasets: [
        { label: 'Average pack temperature', data: [], parsing: false, borderColor: '#1f4fd1', backgroundColor: 'rgba(31,79,209,.12)', borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 3, fill: true, tension: .32 },
        { label: '35 °C setpoint', data: [], borderColor: '#737e8d', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false },
      ] },
      options: chartOptions('temperature'),
    });
    coolingChart = new Chart(byId('cooling-chart'), {
      type: 'line',
      data: { datasets: [
        { label: 'PID fan speed', data: [], parsing: false, borderColor: '#cf7b38', backgroundColor: 'rgba(207,123,56,.12)', borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 3, fill: true, tension: .32 },
      ] },
      options: chartOptions('cooling'),
    });
    return { temperatureChart, coolingChart };
  }

  function refreshChartTheme() {
    if (!temperatureChart || !coolingChart) return;
    temperatureChart.options = chartOptions('temperature');
    coolingChart.options = chartOptions('cooling');
    temperatureChart.update('none');
    coolingChart.update('none');
  }

  function appendFrameToCharts(frame) {
    if (!temperatureChart || !coolingChart) return;
    const timestamp = Number.isFinite(Number(frame.timestamp)) ? Number(frame.timestamp) : Date.now() / 1000;
    const average = Number(frame.temp_avg);
    const fan = Number(frame.fan_speed);
    if (!Number.isFinite(average) || !Number.isFinite(fan)) return;
    // Ignore stale/out-of-order frames so a reconnect cannot rewind or clear the chart.
    if (latestChartTimestamp !== null && timestamp < latestChartTimestamp) return;
    if (latestChartTimestamp !== null && timestamp === latestChartTimestamp) {
      temperatureChart.data.datasets[0].data.at(-1).y = average;
      temperatureChart.data.datasets[1].data.at(-1).y = 35;
      coolingChart.data.datasets[0].data.at(-1).y = fan;
      temperatureChart.update('none');
      coolingChart.update('none');
      return;
    }
    latestChartTimestamp = timestamp;
    const cutoff = latestChartTimestamp - chartWindowSeconds;
    temperatureChart.data.datasets[0].data.push({ x: timestamp, y: average });
    temperatureChart.data.datasets[1].data.push({ x: timestamp, y: 35 });
    coolingChart.data.datasets[0].data.push({ x: timestamp, y: fan });
    temperatureChart.data.datasets.forEach((dataset) => {
      dataset.data = dataset.data.filter((point) => point.x >= cutoff);
    });
    coolingChart.data.datasets.forEach((dataset) => {
      dataset.data = dataset.data.filter((point) => point.x >= cutoff);
    });
    for (const chart of [temperatureChart, coolingChart]) {
      chart.options.scales.x.min = cutoff;
      chart.options.scales.x.max = latestChartTimestamp;
    }
    temperatureChart.update('none');
    coolingChart.update('none');
  }

  function addWarning(message, peak) {
    const stack = byId('warning-stack');
    if (!stack || stack.querySelector(`[data-warning="${peak}"]`)) return;
    const card = document.createElement('div');
    card.className = 'warning-card';
    card.dataset.warning = String(peak);
    const mark = document.createElement('span');
    mark.className = 'warning-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '!';
    const copy = document.createElement('span');
    copy.className = 'warning-copy';
    const title = document.createElement('strong');
    title.textContent = 'Overheat warning';
    const detail = document.createElement('span');
    detail.textContent = message;
    copy.append(title, detail);
    const dismiss = document.createElement('button');
    dismiss.className = 'warning-dismiss';
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss warning');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => card.remove());
    card.append(mark, copy, dismiss);
    stack.append(card);
  }

  function updateFrame(frame, { appendChart = true, historical = false } = {}) {
    if (!frame || !Number.isFinite(Number(frame.temp_avg)) || !Number.isFinite(Number(frame.fan_speed))) return;
    const average = Number(frame.temp_avg);
    const fan = Number(frame.fan_speed);
    const cells = Array.isArray(frame.cell_temps) ? frame.cell_temps.map((value) => Number.isFinite(Number(value)) ? Number(value) : NaN) : [];
    const voltages = Array.isArray(frame.cell_voltages) ? frame.cell_voltages.map((value) => Number.isFinite(Number(value)) ? Number(value) : NaN)
      : Array.isArray(frame.cell_voltage) ? frame.cell_voltage.map((value) => Number.isFinite(Number(value)) ? Number(value) : NaN)
        : Array.isArray(frame.voltages) ? frame.voltages.map((value) => Number.isFinite(Number(value)) ? Number(value) : NaN) : [];
    const validCells = cells.filter(Number.isFinite);
    const peak = validCells.length ? Math.max(...validCells) : average;
    sceneInstances.forEach((instance) => {
      instance.cells.forEach((mesh, index) => {
        const temperature = cells[index];
        mesh.userData.temperature = Number.isFinite(temperature) ? temperature : NaN;
        if (Number.isFinite(temperature)) {
          const mappedColor = thermalColorForTemperature(temperature, mesh.userData.thermalColor);
          mesh.material.color.copy(mappedColor);
          mesh.material.emissive.copy(mappedColor);
        } else {
          mesh.material.color.copy(mesh.userData.baseColor);
          mesh.material.emissive.copy(mesh.userData.baseEmissive);
        }
      });
      if (Number.isInteger(instance.hoveredCellIndex)) setHoverTooltipReading(instance, instance.hoveredCellIndex);
    });
    setText('avg-pack-temp', average.toFixed(2));
    setText('max-cell-temp', peak.toFixed(2));
    const pumpRpm = Number(frame.fan_rpm ?? frame.pump_rpm);
    setText('pid-cooling-rpm', Number.isFinite(pumpRpm) ? pumpRpm.toFixed(0) : '—');
    const faultCount = Array.isArray(frame.faults)
      ? frame.faults.length
      : Array.isArray(frame.active_faults)
        ? frame.active_faults.length
        : Number.isFinite(Number(frame.active_faults))
          ? Number(frame.active_faults)
          : (frame.overheat === true || frame.alert === true || frame.alert === 'overheat' ? 1 : 0);
    setText('active-fault-alerts', String(faultCount));
    setText('avg-temp', average.toFixed(2));
    setText('max-temp', peak.toFixed(2));
    const warningThreshold = Number.isFinite(Number(frame.warning_threshold)) ? Number(frame.warning_threshold) : 40;
    const criticalThreshold = Number.isFinite(Number(frame.alert_threshold)) ? Number(frame.alert_threshold) : 45;
    let hottestCriticalCell = null;
    byId('cell-grid-hud')?.querySelectorAll('.cell-card').forEach((cell, index) => {
      const value = cells[index];
      const voltage = voltages[index];
      const status = Number.isFinite(value) && value >= criticalThreshold ? 'critical'
        : Number.isFinite(value) && value >= warningThreshold ? 'warning' : 'normal';
      cell.classList.toggle('status-warning', status === 'warning');
      cell.classList.toggle('status-critical', status === 'critical');
      cell.classList.toggle('cell-hot', status !== 'normal');
      cell.style.setProperty('--cell-fill', `${Number.isFinite(value) ? Math.max(0, Math.min(100, ((value - 20) / 30) * 100)) : 0}%`);
      const temperatureNode = cell.querySelector('.cell-temp-value');
      const voltageNode = cell.querySelector('.cell-voltage-value');
      const badge = cell.querySelector('.status-badge');
      if (temperatureNode) temperatureNode.textContent = Number.isFinite(value) ? value.toFixed(1) : '—';
      if (voltageNode) voltageNode.textContent = Number.isFinite(voltage) ? voltage.toFixed(3) : '—';
      if (badge) {
        badge.classList.remove('normal', 'warning', 'critical');
        badge.classList.add(status);
        badge.textContent = status;
      }
      cell.setAttribute('aria-label', `Cell #${String(index + 1).padStart(2, '0')}, ${Number.isFinite(value) ? `${value.toFixed(1)} degrees Celsius` : 'temperature unavailable'}, ${Number.isFinite(voltage) ? `${voltage.toFixed(3)} volts` : 'voltage unavailable'}, ${status}`);
      if (status === 'critical' && (!hottestCriticalCell || value > hottestCriticalCell.temperature)) hottestCriticalCell = { index, temperature: value };
    });
    const criticalAlert = Boolean(hottestCriticalCell) || frame.overheat === true || frame.alert === 'overheat';
    const alertBanner = byId('critical-alert-banner');
    if (alertBanner) {
      alertBanner.hidden = !criticalAlert;
      setText('critical-alert-message', hottestCriticalCell
        ? `Cell #${String(hottestCriticalCell.index + 1).padStart(2, '0')} reached ${hottestCriticalCell.temperature.toFixed(1)} °C.`
        : 'The pack reported a high-temperature condition.');
    }
    setText('sim-time', Number.isFinite(Number(frame.timestamp)) ? Number(frame.timestamp).toFixed(1) : '—');
    setText('scale-reading', `${average.toFixed(2)} °C`);
    const marker = byId('scale-marker');
    if (marker) marker.style.left = `${Math.max(0, Math.min(100, ((average - 20) / 30) * 100))}%`;
    const threshold = Number(frame.alert_threshold);
    if (frame.overheat === true || frame.alert === 'overheat' || (Number.isFinite(threshold) && peak >= threshold)) {
      addWarning(`Cell temperature ${peak.toFixed(1)} °C crossed the alert threshold.`, peak.toFixed(1));
    }
    if (!historical) {
      lastTelemetryAt = Date.now();
      const dot = byId('connection-dot');
      dot?.classList.add('connected');
      dot?.classList.remove('disconnected');
      setText('connection-label', 'Live telemetry');
      setText('system-status', 'ONLINE');
      setText('stream-status', 'LIVE STREAM');
    }
    const selectedIndex = Number(byId('cell-grid-hud')?.dataset.selectedIndex);
    if (Number.isInteger(selectedIndex) && selectedIndex >= 0) {
      const selectedValue = cells[selectedIndex];
      setText('selected-cell-readout', Number.isFinite(selectedValue) ? `Cell ${selectedIndex + 1}: ${selectedValue.toFixed(1)} °C` : `Cell ${selectedIndex + 1}: temperature unavailable`);
    }
    if (appendChart) appendFrameToCharts({ ...frame, temp_avg: average, fan_speed: fan });
  }

  async function loadHistory() {
    try {
      const historyUrl = location.protocol === 'file:'
        ? 'http://127.0.0.1:8080/api/history?timeframe=60'
        : '/api/history?timeframe=60';
      const response = await fetch(historyUrl, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
      if (!response.ok) return [];
      const result = await response.json();
      if (!Array.isArray(result.frames)) return [];
      const frames = result.frames
        .filter((frame) => frame && Number.isFinite(Number(frame.timestamp)))
        .sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
      // Seed both rolling charts before the live socket is opened. The endpoint returns
      // ring-buffer frames in chronological order; sorting also tolerates older servers.
      frames.forEach((frame) => appendFrameToCharts(frame));
      if (frames.length) updateFrame(frames[frames.length - 1], { appendChart: false, historical: true });
      return frames;
    } catch (_) { return []; /* continue to live telemetry if history is unavailable */ }
  }

  function resolveWebSocketUrl() {
    if (location.protocol === 'http:' || location.protocol === 'https:') return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
    return 'ws://127.0.0.1:8080';
  }

  async function connectTelemetry() {
    clearTimeout(reconnectTimer);
    const dot = byId('connection-dot');
    dot?.classList.remove('connected', 'disconnected');
    setText('connection-label', 'Loading recent telemetry');
    await loadHistory();
    setText('connection-label', 'Connecting to telemetry');
    try {
      socket = new WebSocket(resolveWebSocketUrl());
      socket.addEventListener('open', () => {
        reconnectDelay = 1000;
        setText('system-status', 'ONLINE');
        setText('connection-label', 'Connected · waiting for frames');
      });
      socket.addEventListener('message', (event) => {
        try { updateFrame(JSON.parse(event.data)); } catch (_) { /* ignore malformed frames */ }
      });
      socket.addEventListener('error', () => socket.close());
      socket.addEventListener('close', () => {
        dot?.classList.remove('connected');
        dot?.classList.add('disconnected');
        setText('system-status', 'OFFLINE');
        setText('stream-status', 'RECONNECTING');
        setText('connection-label', 'Reconnecting to telemetry');
        reconnectTimer = setTimeout(connectTelemetry, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      });
    } catch (_) {
      setText('system-status', 'OFFLINE');
      setText('stream-status', 'RECONNECTING');
      setText('connection-label', 'Backend unavailable');
      reconnectTimer = setTimeout(connectTelemetry, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
    }
  }

  async function initScene(canvasId) {
    if (sceneInstances.has(canvasId)) return sceneInstances.get(canvasId);
    const canvas = byId(canvasId);
    if (!canvas || !await loadThreeDependencies()) return;
    if (sceneInstances.has(canvasId)) return sceneInstances.get(canvasId);
    try {
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, .1, 100);
      camera.position.set(5.7, 5.1, 7.8);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = .075;
      controls.minDistance = 4.5;
      controls.maxDistance = 14;
      controls.target.set(0, 0, 0);
      controls.update();

      scene.add(new THREE.AmbientLight(0xb9c9d8, 1.45));
      const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
      keyLight.position.set(-4.5, 8, 6);
      scene.add(keyLight);
      const fillLight = new THREE.DirectionalLight(0x74d9e8, .9);
      fillLight.position.set(5, 4, -5);
      scene.add(fillLight);

      const cellGeometry = new THREE.BoxGeometry(.92, .34, .64);
      const darkTheme = root.dataset.theme === 'dark';
      const baseCellColor = darkTheme ? 0x46677c : 0x7891a2;
      const cells = [];
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 4; column += 1) {
          const cellIndex = row * 4 + column;
          const material = new THREE.MeshStandardMaterial({
            color: baseCellColor,
            roughness: .36,
            metalness: .38,
            emissive: darkTheme ? 0x06202b : 0x14232c,
            emissiveIntensity: .12,
          });
          const cell = new THREE.Mesh(cellGeometry, material);
          cell.name = `Battery Cell #${String(cellIndex + 1).padStart(2, '0')}`;
          cell.userData.cellIndex = cellIndex;
          cell.userData.temperature = NaN;
          cell.userData.thermalColor = new THREE.Color();
          cell.userData.baseColor = new THREE.Color(baseCellColor);
          cell.userData.baseEmissive = new THREE.Color(darkTheme ? 0x06202b : 0x14232c);
          cell.position.set((column - 1.5) * 1.04, 0, (row - 1.5) * .76);
          scene.add(cell);
          cells.push(cell);
        }
      }
      canvas.parentElement.classList.add('has-3d-scene');
      const parent = canvas.parentElement;
      const resize = () => {
        const bounds = parent.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        renderer.setSize(bounds.width, bounds.height, false);
        camera.aspect = bounds.width / bounds.height;
        camera.updateProjectionMatrix();
      };
      if (canvasId === 'simulation-canvas') {
        resizeSimulationRenderer = resize;
        window.addEventListener('simulation-view-shown', resize);
      }
      const instance = { renderer, scene, camera, controls, cells, resize, hoveredCellIndex: null, tooltip: null };
      sceneInstances.set(canvasId, instance);
      if (canvasId === 'simulation-canvas') {
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        const tooltip = byId('cell-hover-tooltip');
        const tooltipHost = parent.closest('.scene-backdrop');
        instance.tooltip = tooltip;
        renderer.domElement.addEventListener('pointermove', (event) => {
          const bounds = renderer.domElement.getBoundingClientRect();
          if (!bounds.width || !bounds.height || !tooltip || !tooltipHost) return;
          pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
          pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects(cells, false)[0];
          if (!hit) {
            instance.hoveredCellIndex = null;
            tooltip.hidden = true;
            return;
          }
          const cellIndex = hit.object.userData.cellIndex;
          instance.hoveredCellIndex = cellIndex;
          tooltip.hidden = false;
          setHoverTooltipReading(instance, cellIndex);
          const hostBounds = tooltipHost.getBoundingClientRect();
          const left = Math.min(hostBounds.width - tooltip.offsetWidth - 10, event.clientX - hostBounds.left + 14);
          const top = Math.min(hostBounds.height - tooltip.offsetHeight - 10, event.clientY - hostBounds.top + 14);
          tooltip.style.left = `${Math.max(10, left)}px`;
          tooltip.style.top = `${Math.max(10, top)}px`;
        });
        renderer.domElement.addEventListener('pointerleave', () => {
          instance.hoveredCellIndex = null;
          if (tooltip) tooltip.hidden = true;
        });
      }
      new ResizeObserver(resize).observe(parent);
      resize();
      const render = (now) => {
        const simulationPage = byId('page-simulation');
        if (canvasId === 'simulation-canvas' && simulationPage && !simulationPage.classList.contains('active')) {
          requestAnimationFrame(render);
          return;
        }
        controls.update();
        renderer.render(scene, camera);
        if (canvasId === 'simulation-canvas') {
          frameCount += 1;
          if (now - lastFpsSample >= 1000) {
            setText('dashboard-fps', String(Math.round(frameCount * 1000 / (now - lastFpsSample))));
            frameCount = 0;
            lastFpsSample = now;
          }
        }
        requestAnimationFrame(render);
      };
      requestAnimationFrame(render);
      return instance;
    } catch (_) { /* The placeholder remains when WebGL is not available. */ }
  }

  function initCellGrid() {
    const grid = byId('cell-grid-hud');
    if (!grid) return;
    grid.querySelectorAll('.cell-value').forEach((cell) => {
      cell.addEventListener('click', () => {
        grid.dataset.selectedIndex = cell.dataset.cellIndex;
        grid.querySelectorAll('.cell-value').forEach((item) => item.classList.toggle('selected', item === cell));
        const index = Number(cell.dataset.cellIndex);
        const value = cell.querySelector('.cell-temp-value')?.textContent.trim() || '—';
        setText('selected-cell-readout', value === '—' ? `Cell ${index + 1}: temperature unavailable` : `Cell ${index + 1}: ${value} °C`);
      });
    });
  }

  function initPanels() {
    const body = document.body;
    const compact = matchMedia('(max-width: 900px)');
    const closePanels = () => body.classList.remove('charts-open', 'metrics-open');
    const updateLayout = () => {
      if (compact.matches) body.classList.add('charts-hidden', 'metrics-hidden');
      else {
        body.classList.remove('charts-hidden', 'metrics-hidden');
        closePanels();
      }
    };
    byId('hide-charts')?.addEventListener('click', () => {
      if (compact.matches) body.classList.remove('charts-open');
      else body.classList.add('charts-hidden');
    });
    byId('hide-metrics')?.addEventListener('click', () => {
      if (compact.matches) body.classList.remove('metrics-open');
      else body.classList.add('metrics-hidden');
    });
    byId('show-charts')?.addEventListener('click', () => {
      if (compact.matches) body.classList.toggle('charts-open');
      else body.classList.remove('charts-hidden');
    });
    byId('show-metrics')?.addEventListener('click', () => {
      if (compact.matches) body.classList.toggle('metrics-open');
      else body.classList.remove('metrics-hidden');
    });
    byId('mobile-panel-scrim')?.addEventListener('click', closePanels);
    compact.addEventListener('change', updateLayout);
    updateLayout();
  }

  function initPageNavigation() {
    if (routerInitialized) return;
    const home = byId('page-home');
    const simulation = byId('page-simulation');
    if (!home || !simulation) return;
    routerInitialized = true;
    const navLinks = [...document.querySelectorAll('[data-target-page]')];
    function showPage(target) {
      const targetId = target === 'simulation' || target === 'page-simulation' ? 'page-simulation' : 'page-home';
      const showSimulation = targetId === 'page-simulation';
      home.classList.toggle('active', !showSimulation);
      simulation.classList.toggle('active', showSimulation);
      home.classList.toggle('hidden', showSimulation);
      simulation.classList.toggle('hidden', !showSimulation);
      navLinks.forEach((link) => {
        const active = link.dataset.targetPage === targetId;
        link.classList.toggle('active', active);
        link.setAttribute('aria-current', active ? 'page' : 'false');
      });
      document.body.classList.toggle('simulation-active', showSimulation);
      document.body.classList.toggle('home-active', !showSimulation);
      if (showSimulation) {
        history.replaceState(null, '', '#simulation');
        requestAnimationFrame(() => {
          resizeSimulationRenderer();
          window.dispatchEvent(new Event('simulation-view-shown'));
          temperatureChart?.resize();
          coolingChart?.resize();
        });
      } else {
        history.replaceState(null, '', '#home');
      }
    }
    document.addEventListener('click', (event) => {
      const link = event.target.closest('[data-target-page]');
      if (link) {
        event.preventDefault();
        showPage(link.dataset.targetPage);
      } else if (event.target.closest('[data-open-simulation]')) {
        showPage('page-simulation');
      }
    });
    showPage(location.hash === '#simulation' ? 'page-simulation' : 'page-home');
    addEventListener('hashchange', () => showPage(location.hash === '#simulation' ? 'page-simulation' : 'page-home'));
  }

  function validateMountTargets() {
    const targets = ['threejs-container', 'telemetry-chart-container', 'cell-grid-hud'];
    const missing = targets.filter((id) => !byId(id));
    if (missing.length) console.error(`[ThermaSync] Missing required dashboard mount point(s): ${missing.map((id) => `#${id}`).join(', ')}`);
    return missing.length === 0;
  }

  let shaderMapper = null;
  function registerShaderMapper(mapper) {
    if (typeof mapper !== 'function') throw new TypeError('Shader mapper must be a function.');
    shaderMapper = mapper;
    return () => { if (shaderMapper === mapper) shaderMapper = null; };
  }

  function bootstrap() {
    if (window.ThermaSync.initialized) return;
    window.ThermaSync.initialized = true;
    const targetsReady = validateMountTargets();
    initTheme();
    initPageNavigation();
    if (isSimulation) {
      initPanels();
      initCellGrid();
      if (targetsReady && window.Chart) createCharts();
      if (byId('threejs-container')) initScene('simulation-canvas');
      connectTelemetry();
    }
    if (byId('preview-threejs-container')) initScene('preview-canvas');
    document.dispatchEvent(new CustomEvent('thermasync:ready', { detail: { targetsReady } }));
  }

  window.ThermaSync = window.ThermaSync || {};
  Object.assign(window.ThermaSync, {
    initialized: false,
    validateMountTargets,
    router: { initialize: initPageNavigation },
    scene: {
      initialize: initScene,
      getCells: (canvasId = 'simulation-canvas') => sceneInstances.get(canvasId)?.cells || [],
      resize: () => window.dispatchEvent(new Event('simulation-view-shown')),
    },
    shader: { registerMapper, getMapper: () => shaderMapper, mapTemperature: thermalColorForTemperature },
    charts: { initialize: createCharts, refreshTheme: refreshChartTheme },
    hooks: {
      initializeScene: initScene,
      registerShaderMapper,
      initializeLiveCharts: createCharts,
    },
    initialize: bootstrap,
  });

  if (document.readyState === 'complete') {
    bootstrap();
  } else {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  }
})();
