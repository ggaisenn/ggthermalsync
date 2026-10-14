(() => {
  'use strict';

  const root = document.documentElement;
  const themeToggle = document.querySelector('.theme-toggle');
  const themeIcon = document.querySelector('.theme-icon');
  const isSimulation = Boolean(document.getElementById('page-simulation'));
  const maxPoints = 120;
  const temperatureValues = [];
  const coolingValues = [];
  let temperatureChart;
  let coolingChart;
  let socket;
  let reconnectTimer;
  let reconnectDelay = 1000;
  let frameCount = 0;
  let lastFpsSample = performance.now();
  let lastTelemetryAt = 0;

  function byId(id) { return document.getElementById(id); }
  function setText(id, text) { const element = byId(id); if (element) element.textContent = text; }

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

  let savedTheme = 'light';
  try { savedTheme = localStorage.getItem('ggthermalsync-theme') || 'light'; } catch (_) { /* storage may be disabled */ }
  setTheme(savedTheme === 'dark' ? 'dark' : 'light');
  themeToggle?.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

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
        x: { display: false, grid: { display: false }, border: { display: false } },
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
    temperatureChart = new Chart(byId('chart-canvas'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Average temperature', data: temperatureValues, borderColor: '#1f4fd1', backgroundColor: 'rgba(31,79,209,.12)', borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 3, fill: true, tension: .32 },
        { label: '35 °C setpoint', data: [], borderColor: '#737e8d', borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false },
      ] },
      options: chartOptions('temperature'),
    });
    coolingChart = new Chart(byId('cooling-chart'), {
      type: 'line',
      data: { labels: [], datasets: [
        { label: 'Cooling output', data: coolingValues, borderColor: '#cf7b38', backgroundColor: 'rgba(207,123,56,.12)', borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 3, fill: true, tension: .32 },
      ] },
      options: chartOptions('cooling'),
    });
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
    const timeLabel = `${Math.floor(timestamp / 60).toString().padStart(2, '0')}:${Math.floor(timestamp % 60).toString().padStart(2, '0')}`;
    temperatureChart.data.labels.push(timeLabel);
    temperatureChart.data.datasets[0].data.push(frame.temp_avg);
    temperatureChart.data.datasets[1].data.push(35);
    coolingChart.data.labels.push(timeLabel);
    coolingChart.data.datasets[0].data.push(frame.fan_speed);
    while (temperatureChart.data.labels.length > maxPoints) {
      temperatureChart.data.labels.shift();
      temperatureChart.data.datasets.forEach((dataset) => dataset.data.shift());
      coolingChart.data.labels.shift();
      coolingChart.data.datasets[0].data.shift();
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

  function updateFrame(frame) {
    if (!frame || !Number.isFinite(Number(frame.temp_avg)) || !Number.isFinite(Number(frame.fan_speed))) return;
    const average = Number(frame.temp_avg);
    const fan = Number(frame.fan_speed);
    const cells = Array.isArray(frame.cell_temps) ? frame.cell_temps.map(Number).filter(Number.isFinite) : [];
    const peak = cells.length ? Math.max(...cells) : average;
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
    setText('sim-time', Number.isFinite(Number(frame.timestamp)) ? Number(frame.timestamp).toFixed(1) : '—');
    setText('scale-reading', `${average.toFixed(2)} °C`);
    const marker = byId('scale-marker');
    if (marker) marker.style.left = `${Math.max(0, Math.min(100, ((average - 20) / 30) * 100))}%`;
    const threshold = Number(frame.alert_threshold);
    if (frame.overheat === true || frame.alert === 'overheat' || (Number.isFinite(threshold) && peak >= threshold)) {
      addWarning(`Cell temperature ${peak.toFixed(1)} °C crossed the alert threshold.`, peak.toFixed(1));
    }
    lastTelemetryAt = Date.now();
    const dot = byId('connection-dot');
    dot?.classList.add('connected');
    dot?.classList.remove('disconnected');
    setText('connection-label', 'Live telemetry');
    setText('system-status', 'ONLINE');
    setText('stream-status', 'LIVE STREAM');
    byId('cell-grid-hud')?.querySelectorAll('.cell-value').forEach((cell, index) => {
      const value = cells[index];
      cell.textContent = Number.isFinite(value) ? value.toFixed(1) : '—';
      cell.classList.toggle('cell-hot', Number.isFinite(value) && value >= 40);
      cell.setAttribute('aria-label', Number.isFinite(value) ? `Cell ${index + 1}, ${value.toFixed(1)} degrees Celsius` : `Cell ${index + 1} temperature unavailable`);
    });
    const selectedIndex = Number(byId('cell-grid-hud')?.dataset.selectedIndex);
    if (Number.isInteger(selectedIndex) && selectedIndex >= 0) {
      const selectedValue = cells[selectedIndex];
      setText('selected-cell-readout', Number.isFinite(selectedValue) ? `Cell ${selectedIndex + 1}: ${selectedValue.toFixed(1)} °C` : `Cell ${selectedIndex + 1}: temperature unavailable`);
    }
    appendFrameToCharts({ ...frame, temp_avg: average, fan_speed: fan });
  }

  async function loadHistory() {
    try {
      const response = await fetch('/api/history?timeframe=60', { cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      if (Array.isArray(result.frames)) result.frames.forEach(updateFrame);
    } catch (_) { /* websocket state remains visible if history is unavailable */ }
  }

  function resolveWebSocketUrl() {
    if (location.protocol === 'http:' || location.protocol === 'https:') return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
    return 'ws://localhost:8080';
  }

  function connectTelemetry() {
    clearTimeout(reconnectTimer);
    const dot = byId('connection-dot');
    dot?.classList.remove('connected', 'disconnected');
    setText('connection-label', 'Connecting to telemetry');
    try {
      socket = new WebSocket(resolveWebSocketUrl());
      socket.addEventListener('open', () => {
        reconnectDelay = 1000;
        setText('system-status', 'ONLINE');
        setText('connection-label', 'Connected · waiting for frames');
        loadHistory();
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

  function initScene(canvasId) {
    const canvas = byId(canvasId);
    if (!canvas || !window.THREE) return;
    try {
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, .1, 100);
      camera.position.set(0, 0, 8);
      const parent = canvas.parentElement;
      const resize = () => {
        const bounds = parent.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        renderer.setSize(bounds.width, bounds.height, false);
        camera.aspect = bounds.width / bounds.height;
        camera.updateProjectionMatrix();
      };
      new ResizeObserver(resize).observe(parent);
      resize();
      const render = (now) => {
        const simulationPage = byId('page-simulation');
        if (canvasId === 'simulation-canvas' && simulationPage && !simulationPage.classList.contains('active')) {
          requestAnimationFrame(render);
          return;
        }
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
        const value = cell.textContent.trim();
        setText('selected-cell-readout', value === '—' ? `Cell ${index + 1}: temperature unavailable` : `Cell ${index + 1}: ${value} °C`);
      });
    });
  }

  function initPageNavigation() {
    const home = byId('page-home');
    const simulation = byId('page-simulation');
    const homeButton = byId('nav-home');
    const simulationButton = byId('nav-simulation');
    if (!home || !simulation || !homeButton || !simulationButton) return;
    function showPage(page) {
      const showSimulation = page === 'simulation';
      home.classList.toggle('active', !showSimulation);
      simulation.classList.toggle('active', showSimulation);
      homeButton.classList.toggle('active', !showSimulation);
      simulationButton.classList.toggle('active', showSimulation);
      homeButton.setAttribute('aria-current', showSimulation ? 'false' : 'page');
      simulationButton.setAttribute('aria-current', showSimulation ? 'page' : 'false');
      document.body.classList.toggle('simulation-active', showSimulation);
      document.body.classList.toggle('home-active', !showSimulation);
      if (showSimulation) {
        history.replaceState(null, '', '#simulation');
        requestAnimationFrame(() => {
          temperatureChart?.resize();
          coolingChart?.resize();
        });
      } else {
        history.replaceState(null, '', '#home');
      }
    }
    homeButton.addEventListener('click', () => showPage('home'));
    simulationButton.addEventListener('click', () => showPage('simulation'));
    document.querySelectorAll('[data-open-simulation]').forEach((button) => button.addEventListener('click', () => showPage('simulation')));
    const initialPage = location.hash === '#simulation' ? 'simulation' : 'home';
    showPage(initialPage);
    addEventListener('hashchange', () => showPage(location.hash === '#simulation' ? 'simulation' : 'home'));
  }

  if (isSimulation) {
    createCharts();
    initCellGrid();
    initScene('simulation-canvas');
    connectTelemetry();
  }
  initPageNavigation();
  initScene('preview-canvas');
})();
