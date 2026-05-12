if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW registration failed:', err));
}

const DB_NAME = "onkyo-yaro";
    const DB_VERSION = 2;
    const STORE = "audio";
    const STATE_KEY = "onkyo-state-v1";
    const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i;

    const els = {
      fileInput: document.getElementById("fileInput"),
      folderInput: document.getElementById("folderInput"),
      pickFiles: document.getElementById("pickFiles"),
      pickFolder: document.getElementById("pickFolder"),
      importInput: document.getElementById("importInput"),
      importButton: document.getElementById("importButton"),
      exportList: document.getElementById("exportList"),
      exportPackage: document.getElementById("exportPackage"),
      clearAll: document.getElementById("clearAll"),
      safetyLock: document.getElementById("safetyLock"),
      trackList: document.getElementById("trackList"),
      padGrid: document.getElementById("padGrid"),
      inspector: document.getElementById("inspector"),
      listTab: document.getElementById("listTab"),
      padTab: document.getElementById("padTab"),
      editTab: document.getElementById("editTab"),
      nowTitle: document.getElementById("nowTitle"),
      progress: document.getElementById("progress"),
      currentTime: document.getElementById("currentTime"),
      duration: document.getElementById("duration"),
      playPause: document.getElementById("playPause"),
      stopInstant: document.getElementById("stopInstant"),
      stopOne: document.getElementById("stopOne"),
      stopCustom: document.getElementById("stopCustom"),
      nextQueue: document.getElementById("nextQueue"),
      fadeSlider: document.getElementById("fadeSlider"),
      fadeSeconds: document.getElementById("fadeSeconds"),
      transitionMode: document.getElementById("transitionMode"),
      crossfadeSeconds: document.getElementById("crossfadeSeconds"),
      queueMode: document.getElementById("queueMode"),
      clearQueue: document.getElementById("clearQueue"),
      queueList: document.getElementById("queueList"),
      enableMidi: document.getElementById("enableMidi"),
      midiStatus: document.getElementById("midiStatus"),
      dropZone: document.getElementById("dropZone"),
      trackCount: document.getElementById("trackCount"),
      saveStatus: document.getElementById("saveStatus"),
      importStatus: document.getElementById("importStatus"),
      search: document.getElementById("search"),
      storageStatus: document.getElementById("storageStatus")
    };

    let db;
    let tracks = [];
    let queue = [];
    let currentId = null;
    let selectedId = null;
    let currentView = "list";
    let locked = false;
    // Web Audio API State
    let audioContext = null;
    let audioBufferCache = new Map();
    let audioNodes = {
      active: { source: null, gain: null, panner: null, trackId: null, startedAt: 0, offset: 0, paused: true, duration: 0 },
      standby: { source: null, gain: null, panner: null, trackId: null, startedAt: 0, offset: 0, paused: true, duration: 0 },
      preview: { source: null, gain: null, panner: null, trackId: null, startedAt: 0, offset: 0, paused: true, duration: 0 }
    };
    let updateAnimationId = null;
    let draggedId = null;
    let learningHotkeyId = null;
    let learningMidiId = null;
    let autoFadingId = null;
    let midiAccess = null;


    init();

    async function init() {
      db = await openDb();
      await restoreState();
      migrateTracks();
      bindEvents();
      render();
      updateDeck();
      await updateStorageQuota();
      status("前回の状態を復元しました");
    }

    async function updateStorageQuota() {
      if (!navigator.storage || !navigator.storage.estimate) return;
      try {
        const estimate = await navigator.storage.estimate();
        const usage = formatBytes(estimate.usage);
        const quota = formatBytes(estimate.quota);
        els.storageStatus.textContent = `| 容量: ${usage} / ${quota}`;
      } catch (err) {
        console.warn("Storage estimate failed", err);
      }
    }

    function openDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
          if (!db.objectStoreNames.contains("state")) db.createObjectStore("state");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function dbPut(storeName, value, key) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        if (key) tx.objectStore(storeName).put(value, key);
        else tx.objectStore(storeName).put(value, "current");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }

    function dbGet(storeName, key = "current") {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function dbDelete(key) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }

    function bindEvents() {
      els.pickFiles.addEventListener("click", () => els.fileInput.click());
      els.pickFolder.addEventListener("click", () => els.folderInput.click());
      els.importButton.addEventListener("click", () => els.importInput.click());
      els.fileInput.addEventListener("change", event => addFiles(event.target.files));
      els.folderInput.addEventListener("change", event => addFiles(event.target.files));
      els.importInput.addEventListener("change", importJson);
      els.exportList.addEventListener("click", exportListOnly);
      els.exportPackage.addEventListener("click", exportWithAudio);
      els.clearAll.addEventListener("click", clearLibrary);
      els.playPause.addEventListener("click", togglePlayback);
      els.stopInstant.addEventListener("click", () => stopAudio(0));
      els.stopOne.addEventListener("click", () => stopAudio(1));
      els.stopCustom.addEventListener("click", () => stopAudio(Number(els.fadeSeconds.value)));
      els.nextQueue.addEventListener("click", playNextQueued);
      els.clearQueue.addEventListener("click", async () => {
        if (locked) return status("本番ロック中です");
        queue = [];
        renderQueue();
        await saveState();
      });
      els.safetyLock.addEventListener("click", async () => {
        locked = !locked;
        document.body.classList.toggle("locked", locked);
        els.safetyLock.textContent = `本番ロック: ${locked ? "ON" : "OFF"}`;
        render(); // 更新
        await saveState();
      });
      els.search.addEventListener("input", render);
      els.listTab.addEventListener("click", () => switchView("list"));
      els.padTab.addEventListener("click", () => switchView("pad"));
      els.editTab.addEventListener("click", () => switchView("edit"));
      els.transitionMode.addEventListener("change", saveState);
      els.crossfadeSeconds.addEventListener("input", saveState);
      els.queueMode.addEventListener("change", saveState);
      els.enableMidi.addEventListener("click", enableMidi);
      els.fadeSlider.addEventListener("input", () => {
        els.fadeSeconds.value = Number(els.fadeSlider.value).toFixed(1);
        saveState();
      });
      els.fadeSeconds.addEventListener("input", () => {
        const next = Math.max(0.2, Math.min(60, Number(els.fadeSeconds.value) || 3));
        els.fadeSlider.value = Math.min(15, next);
        saveState();
      });

      ["dragenter", "dragover"].forEach(name => {
        els.dropZone.addEventListener(name, event => {
          event.preventDefault();
          els.dropZone.classList.add("active");
        });
      });
      ["dragleave", "drop"].forEach(name => {
        els.dropZone.addEventListener(name, event => {
          event.preventDefault();
          els.dropZone.classList.remove("active");
        });
      });
      els.dropZone.addEventListener("drop", event => addFiles(event.dataTransfer.files));

      document.body.addEventListener("click", () => {
        if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === "suspended") audioContext.resume();
      }, { once: true });
      document.addEventListener("keydown", handleHotkey);
    }

    async function addFiles(fileList) {
      if (locked) {
        status("本番ロック中は音声を追加できません");
        return;
      }
      const files = [...fileList].filter(file => file.type.startsWith("audio/") || AUDIO_EXTENSIONS.test(file.name));
      if (!files.length) {
        status("音声ファイルが見つかりませんでした");
        return;
      }

      for (const file of files) {
        const id = crypto.randomUUID();
        const path = file.webkitRelativePath || file.name;
        tracks.push(defaultTrack({
          id,
          name: file.name,
          path,
          type: file.type || "audio/unknown",
          size: file.size,
          addedAt: Date.now(),
          color: colorFor(tracks.length)
        }));
        await dbPut(STORE, file, id);
      }

      render();
      await updateStorageQuota();
      status(`${files.length}件の音声を追加しました`);
      await saveState();
    }

    function migrateTracks() {
      tracks = tracks.map(defaultTrack);
      queue = queue.filter(id => tracks.some(track => track.id === id));
      if (!selectedId && tracks[0]) selectedId = tracks[0].id;
      if (!tracks.some(track => track.id === currentId)) currentId = null;
    }

    function defaultTrack(track) {
      return {
        id: track.id || crypto.randomUUID(),
        name: track.name || "untitled",
        path: track.path || track.name || "imported",
        type: track.type || "audio/unknown",
        size: track.size || 0,
        addedAt: track.addedAt || Date.now(),
        color: track.color || colorFor(tracks.length),
        tags: Array.isArray(track.tags) ? track.tags : [],
        volume: Number.isFinite(Number(track.volume)) ? Number(track.volume) : 1,
        pan: Number.isFinite(Number(track.pan)) ? Number(track.pan) : 0,
        loop: Boolean(track.loop),
        start: Number.isFinite(Number(track.start)) ? Number(track.start) : 0,
        end: Number.isFinite(Number(track.end)) ? Number(track.end) : 0,
        fadeIn: Number.isFinite(Number(track.fadeIn)) ? Number(track.fadeIn) : 0,
        fadeOut: Number.isFinite(Number(track.fadeOut)) ? Number(track.fadeOut) : 0,
        hotkey: track.hotkey || "",
        midi: track.midi || ""
      };
    }

    function colorFor(index) {
      const colors = ["#f8c94d", "#20d6c7", "#ff5b6c", "#8bea78", "#8ea7ff", "#ff9f43"];
      return colors[index % colors.length];
    }

    async function getAudioBuffer(id, blob) {
      if (audioBufferCache.has(id)) return audioBufferCache.get(id);
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      try {
        const arrayBuffer = await blob.arrayBuffer();
        // decodeAudioDataはPromise形式とコールバック形式の両方を考慮
        const decodePromise = audioContext.decodeAudioData(arrayBuffer);
        if (decodePromise) {
          const buffer = await decodePromise;
          audioBufferCache.set(id, buffer);
          return buffer;
        }
      } catch (err) {
        console.error("Audio decode failed", id, err);
        status("音声の再生準備に失敗しました（ファイル形式や容量制限の可能性があります）");
        throw err;
      }
    }

    function createDeck(track, buffer, volume) {
      const source = audioContext.createBufferSource();
      const gain = audioContext.createGain();
      const panner = audioContext.createStereoPanner();

      source.buffer = buffer;
      source.loop = track.loop;
      if (source.loop) {
        source.loopStart = track.start || 0;
        source.loopEnd = track.end > 0 ? track.end : buffer.duration;
      }
      
      gain.gain.value = clamp(Number(volume), 0, 1);
      panner.pan.value = clamp(Number(track.pan), -1, 1);

      source.connect(gain);
      gain.connect(panner);
      panner.connect(audioContext.destination); 

      source.onended = () => {
        if (source === audioNodes.active.source && !audioNodes.active.paused) {
          handleEnded();
        }
      };

      return { source, gain, panner, duration: buffer.duration };
    }

    function stopDeck(deck) {
      if (deck.source) {
        deck.source.onended = null;
        try { deck.source.stop(); } catch(e) {}
        deck.source.disconnect();
        deck.gain.disconnect();
        deck.panner.disconnect();
      }
      deck.source = null;
      deck.gain = null;
      deck.panner = null;
      deck.paused = true;
    }

    async function playTrack(id, options = {}) {
      const track = tracks.find(item => item.id === id);
      if (!track) return;
      selectedId = id;
      autoFadingId = null;
      
      const blob = await dbGet(STORE, id);
      if (!blob) return status("保存済み音声が見つかりません");
      
      const mode = options.mode || els.transitionMode.value;
      if (currentId && currentId !== id && !audioNodes.active.paused && mode !== "instant") {
        await transitionToTrack(track, blob, mode);
        return;
      }

      currentId = id;
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") await audioContext.resume();
      const buffer = await getAudioBuffer(id, blob);
      stopDeck(audioNodes.active);

      const targetVolume = clamp(Number(track.volume), 0, 1);
      const startVol = track.fadeIn > 0 ? 0 : targetVolume;
      const deckObj = createDeck(track, buffer, startVol);
      
      audioNodes.active.source = deckObj.source;
      audioNodes.active.gain = deckObj.gain;
      audioNodes.active.panner = deckObj.panner;
      audioNodes.active.trackId = id;
      audioNodes.active.duration = deckObj.duration;
      audioNodes.active.paused = false;
      audioNodes.active.offset = Math.max(0, track.start || 0);

      audioNodes.active.source.start(0, audioNodes.active.offset);
      audioNodes.active.startedAt = audioContext.currentTime - audioNodes.active.offset;

      if (track.fadeIn > 0) {
        audioNodes.active.gain.gain.setValueAtTime(0, audioContext.currentTime);
        audioNodes.active.gain.gain.linearRampToValueAtTime(targetVolume, audioContext.currentTime + track.fadeIn);
      }

      await saveState();
      render();
      startProgressLoop();
    }

    async function transitionToTrack(track, blob, mode) {
      const seconds = Math.max(0, Number(els.crossfadeSeconds.value) || 0);
      const targetVolume = clamp(Number(track.volume), 0, 1);
      
      const buffer = await getAudioBuffer(track.id, blob);
      const incoming = createDeck(track, buffer, 0);
      
      if (mode === "fadeThenPlay") {
        const activeGain = audioNodes.active.gain;
        if (activeGain) {
          activeGain.gain.setValueAtTime(activeGain.gain.value, audioContext.currentTime);
          activeGain.gain.linearRampToValueAtTime(0, audioContext.currentTime + seconds);
        }
        setTimeout(() => {
          stopDeck(audioNodes.active);
          audioNodes.active.source = incoming.source;
          audioNodes.active.gain = incoming.gain;
          audioNodes.active.panner = incoming.panner;
          audioNodes.active.trackId = track.id;
          audioNodes.active.duration = incoming.duration;
          audioNodes.active.paused = false;
          audioNodes.active.offset = Math.max(0, track.start || 0);
          audioNodes.active.gain.gain.setValueAtTime(targetVolume, audioContext.currentTime);
          audioNodes.active.source.start(0, audioNodes.active.offset);
          audioNodes.active.startedAt = audioContext.currentTime - audioNodes.active.offset;
          currentId = track.id;
          selectedId = track.id;
          saveState(); render(); updateDeck();
        }, seconds * 1000);
      } else {
        const activeGain = audioNodes.active.gain;
        if (activeGain) {
          activeGain.gain.setValueAtTime(activeGain.gain.value, audioContext.currentTime);
          activeGain.gain.linearRampToValueAtTime(0, audioContext.currentTime + seconds);
          const oldDeck = { ...audioNodes.active };
          setTimeout(() => stopDeck(oldDeck), seconds * 1000);
        }
        
        audioNodes.active.source = incoming.source;
        audioNodes.active.gain = incoming.gain;
        audioNodes.active.panner = incoming.panner;
        audioNodes.active.trackId = track.id;
        audioNodes.active.duration = incoming.duration;
        audioNodes.active.paused = false;
        audioNodes.active.offset = Math.max(0, track.start || 0);
        
        audioNodes.active.gain.gain.setValueAtTime(0, audioContext.currentTime);
        audioNodes.active.gain.gain.linearRampToValueAtTime(targetVolume, audioContext.currentTime + seconds);
        audioNodes.active.source.start(0, audioNodes.active.offset);
        audioNodes.active.startedAt = audioContext.currentTime - audioNodes.active.offset;
        
        currentId = track.id;
        selectedId = track.id;
        render(); updateDeck();
        await saveState();
      }
    }

    async function togglePlayback() {
      if (!currentId && tracks[0]) {
        await playTrack(tracks[0].id);
        return;
      }
      if (!currentId) return;
      if (audioNodes.active.paused) {
        const track = tracks.find(item => item.id === currentId);
        if (!track) return;
        const blob = await dbGet(STORE, currentId);
        const buffer = await getAudioBuffer(currentId, blob);
        const targetVolume = clamp(Number(track.volume), 0, 1);
        
        const deckObj = createDeck(track, buffer, targetVolume);
        audioNodes.active.source = deckObj.source;
        audioNodes.active.gain = deckObj.gain;
        audioNodes.active.panner = deckObj.panner;
        audioNodes.active.paused = false;
        
        audioNodes.active.source.start(0, audioNodes.active.offset);
        audioNodes.active.startedAt = audioContext.currentTime - audioNodes.active.offset;
        startProgressLoop();
      } else {
        audioNodes.active.offset = audioContext.currentTime - audioNodes.active.startedAt;
        stopDeck(audioNodes.active);
      }
      updateDeck();
    }

    function stopAudio(seconds) {
      if (!currentId || audioNodes.active.paused) return;
      if (!seconds || seconds <= 0) {
        hardStop();
        return;
      }
      const gain = audioNodes.active.gain;
      if (gain) {
        gain.gain.setValueAtTime(gain.gain.value, audioContext.currentTime);
        gain.gain.linearRampToValueAtTime(0, audioContext.currentTime + seconds);
        setTimeout(() => hardStop(), seconds * 1000);
      }
      status(`${seconds.toFixed(1)}秒でフェードアウト中`);
    }

    function hardStop() {
      stopDeck(audioNodes.active);
      audioNodes.active.offset = 0;
      updateDeck();
      status("停止しました");
    }

    function clearFade() {}

    function render() {
      const query = els.search.value.trim().toLowerCase();
      const visible = tracks.filter(track => `${track.name} ${track.path} ${track.tags.join(" ")} ${track.hotkey} ${track.midi}`.toLowerCase().includes(query));
      els.trackCount.textContent = `${tracks.length} tracks`;
      els.trackList.innerHTML = "";
      els.padGrid.innerHTML = "";

      if (!tracks.length) {
        els.trackList.innerHTML = '<div class="empty">音声ファイルを追加すると、ここにリスト表示されます。</div>';
        els.padGrid.innerHTML = '<div class="empty">ポン出しパッドは音声追加後に表示されます。</div>';
        renderInspector();
        renderQueue();
        return;
      }

      if (!visible.length) {
        els.trackList.innerHTML = '<div class="empty">検索条件に一致する音声がありません。</div>';
        els.padGrid.innerHTML = '<div class="empty">検索条件に一致するパッドがありません。</div>';
        renderInspector();
        renderQueue();
        return;
      }

      visible.forEach(track => {
        const index = tracks.findIndex(item => item.id === track.id);
        const row = document.createElement("div");
        row.className = `track ${track.id === currentId ? "active" : ""}`;
        row.draggable = !locked;
        row.dataset.id = track.id;
        row.innerHTML = `
          <button type="button" title="再生" data-action="play">▶</button>
          <div class="track-main">
            <div class="track-name" style="border-left:4px solid ${track.color}; padding-left:8px;">${escapeHtml(track.name)}</div>
            <div class="track-meta">${escapeHtml(track.path)} ・ ${formatBytes(track.size)} ${track.hotkey ? "・Key " + escapeHtml(track.hotkey) : ""} ${track.midi ? "・MIDI " + escapeHtml(track.midi) : ""}</div>
            <div class="track-meta">${track.tags.map(tag => `<span class="pill">${escapeHtml(tag)}</span>`).join(" ")}</div>
          </div>
          <div class="track-actions">
            <label class="toggle-switch" title="ループ" style="transform: scale(0.8); margin-right: 6px;">
              <input type="checkbox" class="list-loop-toggle" ${track.loop ? "checked" : ""}>
              <span class="slider"></span>
            </label>
            <button type="button" title="確認用出力で試聴" data-action="preview">P</button>
            <button type="button" title="キューへ追加" data-action="queue">Q</button>
            <button type="button" title="詳細編集" data-action="edit">⚙</button>
            <button type="button" title="上へ" class="edit-control" data-action="up" ${index === 0 || locked ? "disabled" : ""}>↑</button>
            <button type="button" title="下へ" class="edit-control" data-action="down" ${index === visible.length - 1 || locked ? "disabled" : ""}>↓</button>
            <button type="button" title="削除" class="danger edit-control" data-action="remove" ${locked ? "disabled" : ""}>×</button>
          </div>
        `;
        row.addEventListener("click", event => handleTrackAction(event, track.id));
        const toggle = row.querySelector(".list-loop-toggle");
        if (toggle) {
          toggle.addEventListener("change", async (e) => {
            await updateTrackField(track.id, "loop", e.target.checked.toString());
            if (selectedId === track.id) renderInspector();
          });
        }
        row.addEventListener("dragstart", () => {
          draggedId = track.id;
          row.classList.add("dragging");
        });
        row.addEventListener("dragend", () => {
          draggedId = null;
          row.classList.remove("dragging");
        });
        row.addEventListener("dragover", event => event.preventDefault());
        row.addEventListener("drop", async event => {
          event.preventDefault();
          if (!draggedId || draggedId === track.id) return;
          moveTrackBefore(draggedId, track.id);
          await saveState();
          render();
        });
        els.trackList.appendChild(row);

        const pad = document.createElement("button");
        pad.type = "button";
        pad.className = `pad ${track.id === currentId ? "active" : ""}`;
        pad.style.borderTopColor = track.color;
        pad.dataset.id = track.id;
        pad.innerHTML = `
          <strong>${escapeHtml(track.name)}</strong>
          <span>${track.tags.join(" / ") || "No tag"}${track.hotkey ? " ・ " + escapeHtml(track.hotkey) : ""}</span>
        `;
        pad.addEventListener("click", () => playTrack(track.id));
        els.padGrid.appendChild(pad);
      });

      renderInspector();
      renderQueue();
    }

    async function handleTrackAction(event, id) {
      const btn = event.target.closest("button");
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      
      if (action === "play") await playTrack(id);
      else if (action === "preview") await previewTrack(id);
      else if (action === "queue") await addToQueue(id);
      else if (action === "edit") {
        selectedId = id;
        switchView("edit");
      }
      else if (action === "up") await moveBy(id, -1);
      else if (action === "down") await moveBy(id, 1);
      else if (action === "remove") await removeTrack(id);
    }

    async function moveBy(id, delta) {
      if (locked) return status("本番ロック中です");
      const index = tracks.findIndex(track => track.id === id);
      const next = index + delta;
      if (next < 0 || next >= tracks.length) return;
      const [track] = tracks.splice(index, 1);
      tracks.splice(next, 0, track);
      await saveState();
      render();
    }

    function moveTrackBefore(sourceId, targetId) {
      if (locked) return;
      const sourceIndex = tracks.findIndex(track => track.id === sourceId);
      const targetIndex = tracks.findIndex(track => track.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const [track] = tracks.splice(sourceIndex, 1);
      const adjustedTarget = tracks.findIndex(item => item.id === targetId);
      tracks.splice(adjustedTarget, 0, track);
    }

    async function removeTrack(id) {
      if (locked) return status("本番ロック中です");
      if (id === currentId) {
        hardStop();
        currentId = null;
      }
      
      // 即座にUIから消す
      tracks = tracks.filter(track => track.id !== id);
      render();
      
      // バックグラウンドで削除処理
      try {
        await dbDelete(id);
        await saveState();
        updateDeck();
        await updateStorageQuota();
        status("リストから削除しました");
      } catch (err) {
        console.error("Delete failed", err);
        status("削除中にエラーが発生しました");
      }
    }

    async function clearLibrary() {
      if (!tracks.length) return;
      if (locked) return status("本番ロック中です");
      if (!confirm("リストとブラウザ内に保存した音声をすべて消去しますか？")) return;
      
      hardStop();
      const tracksToClear = [...tracks];
      
      // 即座にUIをクリア
      tracks = [];
      currentId = null;
      render();
      
      status("消去中...");
      
      try {
        // 並列で削除を実行して高速化
        await Promise.all(tracksToClear.map(t => dbDelete(t.id)));
        await saveState();
        updateDeck();
        await updateStorageQuota();
        status("全消去しました");
      } catch (err) {
        console.error("Clear all failed", err);
        status("消去中にエラーが発生しました");
      }
    }

    function switchView(view) {
      currentView = view;
      [
        [els.listTab, els.trackList, "list"],
        [els.padTab, els.padGrid, "pad"],
        [els.editTab, els.inspector, "edit"]
      ].forEach(([tab, panel, name]) => {
        tab.classList.toggle("active", view === name);
        panel.classList.toggle("active", view === name);
      });
      saveState();
      if (view === "edit") renderInspector();
    }

    async function addToQueue(id) {
      queue.push(id);
      renderQueue();
      status("キューに追加しました");
      await saveState();
    }

    async function playNextQueued() {
      const next = queue.shift();
      if (!next) return status("キューは空です");
      renderQueue();
      await saveState();
      await playTrack(next, { mode: els.queueMode.value === "fade" ? "crossfade" : els.transitionMode.value });
    }

    function renderQueue() {
      els.queueList.innerHTML = "";
      if (!queue.length) {
        els.queueList.innerHTML = '<div class="empty">次に鳴らす音をQボタンで追加できます。</div>';
        return;
      }
      queue.forEach((id, index) => {
        const track = tracks.find(item => item.id === id);
        if (!track) return;
        const item = document.createElement("div");
        item.className = "queue-item";
        item.innerHTML = `
          <div>
            <strong>${index + 1}. ${escapeHtml(track.name)}</strong>
            <span>${escapeHtml(track.tags.join(" / "))}</span>
          </div>
          <button type="button" class="edit-control" ${locked ? "disabled" : ""}>×</button>
        `;
        item.querySelector("button").addEventListener("click", async () => {
          if (locked) return;
          queue.splice(index, 1);
          await saveState();
          renderQueue();
        });
        els.queueList.appendChild(item);
      });
    }

    async function previewTrack(id) {
      const track = tracks.find(item => item.id === id);
      const blob = await dbGet(STORE, id);
      if (!track || !blob) return status("試聴できる音声がありません");
      
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") await audioContext.resume();
      
      stopDeck(audioNodes.preview);
      const buffer = await getAudioBuffer(id, blob);
      const targetVolume = Math.min(0.85, track.volume);
      const deckObj = createDeck(track, buffer, targetVolume);
      
      audioNodes.preview.source = deckObj.source;
      audioNodes.preview.gain = deckObj.gain;
      audioNodes.preview.panner = deckObj.panner;
      audioNodes.preview.paused = false;
      
      audioNodes.preview.source.start(0, track.start || 0);
    }

    function renderInspector() {
      const track = tracks.find(item => item.id === selectedId) || tracks[0];
      if (!track) {
        els.inspector.innerHTML = '<div class="empty">編集する音声を選択してください。</div>';
        return;
      }
      selectedId = track.id;
      els.inspector.innerHTML = `
        <div class="inspector-head">
          <div>
            <div class="label">Track Detail</div>
            <strong>${escapeHtml(track.name)}</strong>
          </div>
          <button type="button" id="drawWave">波形更新</button>
        </div>
        <div class="wave-container">
          <canvas id="waveCanvas" width="900" height="180"></canvas>
          <canvas id="waveCanvasOverlay" width="900" height="180"></canvas>
        </div>
        <div class="mini-grid">
          <label>タグ
            <input data-field="tags" value="${escapeHtml(track.tags.join(", "))}" placeholder="BGM, 拍手, 緊急">
          </label>
          <label>色
            <input data-field="color" type="color" value="${escapeHtml(track.color)}">
          </label>
          <label>音量
            <input data-field="volume" type="range" min="0" max="1" step="0.01" value="${track.volume}">
          </label>
          <label>パン
            <input data-field="pan" type="range" min="-1" max="1" step="0.01" value="${track.pan}">
          </label>
          <label>開始秒
            <input data-field="start" type="number" min="0" step="0.1" value="${track.start}">
          </label>
          <label>終了秒
            <input data-field="end" type="number" min="0" step="0.1" value="${track.end}">
          </label>
          <label>フェードイン秒
            <input data-field="fadeIn" type="number" min="0" max="30" step="0.1" value="${track.fadeIn}">
          </label>
          <label>曲別フェードアウト秒
            <input data-field="fadeOut" type="number" min="0" max="30" step="0.1" value="${track.fadeOut}">
          </label>
          <div class="toggle-label">
            <span style="color:var(--muted); font-size:12px;">ループ</span>
            <label class="toggle-switch">
              <input data-field="loop" type="checkbox" ${track.loop ? "checked" : ""}>
              <span class="slider"></span>
            </label>
          </div>
          <label>ホットキー
            <input data-field="hotkey" value="${escapeHtml(track.hotkey)}" placeholder="例: F1 / KeyA / Digit1">
          </label>
        </div>
        <div class="hotkey">
          <button type="button" id="learnHotkey">ホットキー学習</button>
          <button type="button" id="learnMidi">MIDI学習</button>
          <span class="status">現在: Key ${escapeHtml(track.hotkey || "-")} / MIDI ${escapeHtml(track.midi || "-")}</span>
        </div>
      `;

      els.inspector.querySelectorAll("[data-field]").forEach(input => {
        const eventName = ["tags", "hotkey", "loop"].includes(input.dataset.field) ? "change" : "input";
        input.addEventListener(eventName, async () => {
          const val = input.type === "checkbox" ? input.checked.toString() : input.value;
          await updateTrackField(track.id, input.dataset.field, val);
        });
      });
      els.inspector.querySelector("#learnHotkey").addEventListener("click", () => {
        learningHotkeyId = track.id;
        status("次に押したキーをこの音声のホットキーに登録します");
      });
      els.inspector.querySelector("#learnMidi").addEventListener("click", async () => {
        learningMidiId = track.id;
        await enableMidi();
        status("次に受けたMIDIノート/CCをこの音声に登録します");
      });
      els.inspector.querySelector("#drawWave").addEventListener("click", () => drawWaveform(track.id));
      drawWaveform(track.id);
      setupWaveformInteraction(track.id);
    }

    let trackDurationCache = 0;

    function setupWaveformInteraction(id) {
      const overlay = document.getElementById("waveCanvasOverlay");
      if (!overlay) return;
      let draggingTrim = null;

      function getClickTime(e) {
        const rect = overlay.getBoundingClientRect();
        const x = e.clientX - rect.left;
        return trackDurationCache ? Math.max(0, (x / rect.width) * trackDurationCache) : 0;
      }

      overlay.addEventListener("mousedown", e => {
        if (!trackDurationCache) return;
        const track = tracks.find(item => item.id === id);
        if (!track) return;
        const clickTime = getClickTime(e);
        const endT = track.end > 0 ? track.end : trackDurationCache;
        const distStart = Math.abs(clickTime - (track.start || 0));
        const distEnd = Math.abs(clickTime - endT);
        draggingTrim = distStart < distEnd ? "start" : "end";
        updateTrim(track, clickTime);
      });

      overlay.addEventListener("mousemove", e => {
        if (!draggingTrim || !trackDurationCache) return;
        const track = tracks.find(item => item.id === id);
        if (!track) return;
        updateTrim(track, getClickTime(e));
      });

      window.addEventListener("mouseup", async () => {
        if (draggingTrim) {
          draggingTrim = null;
          await saveState();
        }
      }, { once: false });

      function updateTrim(track, time) {
        if (draggingTrim === "start") {
          const endT = track.end > 0 ? track.end : trackDurationCache;
          track.start = Math.min(time, endT - 0.1);
          els.inspector.querySelector('[data-field="start"]').value = track.start.toFixed(2);
        } else {
          track.end = Math.max(time, (track.start || 0) + 0.1);
          els.inspector.querySelector('[data-field="end"]').value = track.end.toFixed(2);
        }
        const ctx = overlay.getContext("2d");
        drawTrimOverlay(ctx, overlay, track, trackDurationCache);
      }
    }

    async function updateTrackField(id, field, value) {
      const track = tracks.find(item => item.id === id);
      if (!track) return;
      if (field === "tags") track.tags = value.split(",").map(tag => tag.trim()).filter(Boolean);
      else if (field === "loop") track.loop = value === "true";
      else if (["volume", "pan", "start", "end", "fadeIn", "fadeOut"].includes(field)) track[field] = Number(value) || 0;
      else track[field] = value;
      if (id === currentId) {
        if (audioNodes.active.gain) {
          audioNodes.active.gain.gain.value = track.volume;
        }
        if (audioNodes.active.source && field === "loop") {
          audioNodes.active.source.loop = track.loop;
        }
        applyPan(track.pan);
      }
      await saveState();
      if (["tags", "color", "hotkey", "midi"].includes(field)) render();
    }

    async function drawWaveform(id) {
      const canvas = document.getElementById("waveCanvas");
      const overlay = document.getElementById("waveCanvasOverlay");
      if (!canvas || !overlay) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#0d0f13";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const track = tracks.find(item => item.id === id);
      const blob = await dbGet(STORE, id);
      if (!track || !blob) return;
      try {
        let buffer = audioBufferCache.get(id);
        if (!buffer) {
          const context = new (window.AudioContext || window.webkitAudioContext)();
          buffer = await context.decodeAudioData(await blob.arrayBuffer());
          audioBufferCache.set(id, buffer);
        }
        trackDurationCache = buffer.duration;
        const data = buffer.getChannelData(0);
        const step = Math.ceil(data.length / canvas.width);
        const mid = canvas.height / 2;
        ctx.strokeStyle = track.color;
        ctx.beginPath();
        for (let x = 0; x < canvas.width; x += 1) {
          let min = 1;
          let max = -1;
          for (let i = 0; i < step; i += 1) {
            const datum = data[(x * step) + i] || 0;
            if (datum < min) min = datum;
            if (datum > max) max = datum;
          }
          ctx.moveTo(x, mid + min * mid);
          ctx.lineTo(x, mid + max * mid);
        }
        ctx.stroke();
        const overlayCtx = overlay.getContext("2d");
        drawTrimOverlay(overlayCtx, overlay, track, trackDurationCache);
      } catch {
        ctx.fillStyle = "#a6adba";
        ctx.fillText("この形式は波形解析できませんでした", 18, 32);
      }
    }

    function drawTrimOverlay(ctx, canvas, track, duration) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const startX = duration ? (track.start / duration) * canvas.width : 0;
      const endX = track.end > 0 && duration ? (track.end / duration) * canvas.width : canvas.width;
      ctx.fillStyle = "rgba(255, 91, 108, .22)";
      ctx.fillRect(0, 0, startX, canvas.height);
      ctx.fillRect(endX, 0, canvas.width - endX, canvas.height);
      ctx.fillStyle = "rgba(248, 201, 77, .9)";
      ctx.fillRect(startX, 0, 2, canvas.height);
      ctx.fillRect(endX, 0, 2, canvas.height);
    }

    async function saveState() {
      const state = {
        tracks,
        queue,
        currentId,
        selectedId,
        currentView,
        locked,
        fadeSeconds: Number(els.fadeSeconds.value) || 3,
        transitionMode: els.transitionMode.value,
        crossfadeSeconds: Number(els.crossfadeSeconds.value) || 2,
        queueMode: els.queueMode.value,
        savedAt: new Date().toISOString()
      };
      if (db) {
        await dbPut("state", state);
      }
      els.saveStatus.textContent = "自動保存済み";
    }

    async function restoreState() {
      if (!db) return;
      try {
        const state = await dbGet("state");
        if (!state) return;
        tracks = Array.isArray(state.tracks) ? state.tracks : [];
        queue = Array.isArray(state.queue) ? state.queue : [];
        currentId = state.currentId || null;
        selectedId = state.selectedId || currentId || null;
        currentView = state.currentView || "list";
        locked = Boolean(state.locked);
        const seconds = Number(state.fadeSeconds) || 3;
        els.fadeSeconds.value = seconds.toFixed(1);
        els.fadeSlider.value = Math.min(15, seconds);
        els.transitionMode.value = state.transitionMode || "instant";
        els.crossfadeSeconds.value = Number(state.crossfadeSeconds || 2).toFixed(1);
        els.queueMode.value = state.queueMode || "manual";
        document.body.classList.toggle("locked", locked);
        els.safetyLock.textContent = `本番ロック: ${locked ? "ON" : "OFF"}`;
        requestAnimationFrame(() => switchView(currentView));
      } catch (err) {
        console.warn("Restore state failed", err);
        tracks = [];
      }
    }

    function exportListOnly() {
      const data = {
        app: "音響野郎",
        version: 1,
        type: "list",
        exportedAt: new Date().toISOString(),
        settings: exportSettings(),
        tracks: tracks.map(({ dataUrl, ...track }) => track)
      };
      downloadJson(data, `onkyo-list-${dateStamp()}.json`);
      status("リストのみを書き出しました");
    }

    async function exportWithAudio() {
      if (typeof JSZip === "undefined") return status("ZIPライブラリが読み込まれていません");
      status("パッケージ作成中...");
      const zip = new JSZip();
      const packaged = [];
      const audioFolder = zip.folder("audio");

      for (const track of tracks) {
        const blob = await dbGet(STORE, track.id);
        if (blob) {
          audioFolder.file(track.id, blob);
        }
        packaged.push(track);
      }
      
      const metadata = {
        app: "音響野郎",
        version: 2,
        type: "package-zip",
        exportedAt: new Date().toISOString(),
        settings: exportSettings(),
        tracks: packaged
      };
      
      zip.file("metadata.json", JSON.stringify(metadata, null, 2));
      const zipBlob = await zip.generateAsync({ type: "blob" });
      downloadBlob(zipBlob, `onkyo-package-${dateStamp()}.zip`);
      status("音声込みパッケージ(.zip)を書き出しました");
    }

    async function importJson(event) {
      if (locked) {
        status("本番ロック中はリストを読み込めません");
        event.target.value = "";
        return;
      }
      const file = event.target.files[0];
      event.target.value = "";
      if (!file) return;
      
      status("読み込み中...");
      try {
        if (file.name.endsWith(".zip") || file.name.endsWith(".sdpkg") || file.type === "application/zip" || file.type === "application/x-zip-compressed") {
          if (typeof JSZip === "undefined") throw new Error("ZIPライブラリが読み込まれていません");
          const zip = await JSZip.loadAsync(file);
          const metaFile = zip.file("metadata.json");
          if (!metaFile) throw new Error("metadata.jsonが見つかりません");
          
          const data = JSON.parse(await metaFile.async("string"));
          const imported = [];
          
          for (const item of data.tracks) {
            const id = crypto.randomUUID();
            const track = defaultTrack({ ...item, id, addedAt: Date.now() });
            
            const audioFile = zip.file(`audio/${item.id}`);
            if (audioFile) {
              const blob = await audioFile.async("blob");
              track.size = blob.size;
              track.type = blob.type || item.type || "audio/mpeg";
              await dbPut(STORE, blob, id);
            }
            imported.push(track);
          }
          tracks = tracks.concat(imported);
          await saveState();
          render();
          await updateStorageQuota();
          status(`${imported.length}件を読み込みました`);
          
        } else {
          const data = JSON.parse(await file.text());
          if (!Array.isArray(data.tracks)) throw new Error("Invalid list");
          const imported = [];
          for (const item of data.tracks) {
            const id = crypto.randomUUID();
            const track = defaultTrack({ ...item, id, addedAt: Date.now() });
            if (item.dataUrl) {
              const blob = dataUrlToBlob(item.dataUrl);
              track.size = blob.size;
              track.type = blob.type || track.type;
              await dbPut(STORE, blob, id);
            }
            imported.push(track);
          }
          tracks = tracks.concat(imported);
          await saveState();
          render();
          await updateStorageQuota();
          status(`${imported.length}件を読み込みました${data.type === "list" ? "。リストのみのため音声ファイルは含まれていません" : ""}`);
        }
      } catch (error) {
        console.error(error);
        status("ファイルを読み込めませんでした");
      }
    }

    function exportSettings() {
      return {
        fadeSeconds: Number(els.fadeSeconds.value) || 3,
        transitionMode: els.transitionMode.value,
        crossfadeSeconds: Number(els.crossfadeSeconds.value) || 2,
        queueMode: els.queueMode.value
      };
    }

    function updateDeck() {
      const track = tracks.find(item => item.id === currentId);
      els.nowTitle.textContent = track ? track.name : "音声を選択してください";
      els.playPause.textContent = audioNodes.active.paused ? "再生" : "一時停止";
      const duration = track ? (track.end > 0 ? track.end : audioNodes.active.duration) : 0;
      
      let current = 0;
      if (!audioNodes.active.paused && audioContext) {
        current = audioContext.currentTime - audioNodes.active.startedAt;
      } else {
        current = audioNodes.active.offset || 0;
      }
      
      if (track && track.loop) {
        const loopStart = track.start || 0;
        const loopEnd = track.end > 0 ? track.end : audioNodes.active.duration;
        const loopLength = loopEnd - loopStart;
        if (loopLength > 0 && current > loopEnd) {
          current = loopStart + ((current - loopStart) % loopLength);
        }
      }
      
      els.currentTime.textContent = formatTime(current);
      els.duration.textContent = formatTime(duration);
      els.progress.style.width = duration ? `${Math.min(100, (current / duration) * 100)}%` : "0%";
      
      if (track && track.end > 0 && track.fadeOut > 0 && !autoFadingId && !audioNodes.active.paused) {
        if (current >= track.end - track.fadeOut) {
          autoFadingId = track.id;
          const gain = audioNodes.active.gain;
          if (gain) {
            gain.gain.setValueAtTime(gain.gain.value, audioContext.currentTime);
            gain.gain.linearRampToValueAtTime(0, audioContext.currentTime + track.fadeOut);
          }
        }
      }
      
      if (track && !track.loop && track.end > 0 && !audioNodes.active.paused) {
        if (current >= track.end) {
          handleEnded();
        }
      }
    }

    function startProgressLoop() {
      if (updateAnimationId) cancelAnimationFrame(updateAnimationId);
      function loop() {
        if (!audioNodes.active.paused) {
          updateDeck();
          updateAnimationId = requestAnimationFrame(loop);
        }
      }
      loop();
    }

    async function handleEnded() {
      autoFadingId = null;
      stopDeck(audioNodes.active);
      audioNodes.active.offset = 0;
      updateDeck();
      if (queue.length && els.queueMode.value !== "manual") await playNextQueued();
    }

    function handleHotkey(event) {
      const editable = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
      if (learningHotkeyId) {
        event.preventDefault();
        const track = tracks.find(item => item.id === learningHotkeyId);
        if (track) {
          track.hotkey = event.code;
          learningHotkeyId = null;
          saveState();
          render();
          status(`ホットキー ${event.code} を登録しました`);
        }
        return;
      }
      if (editable || event.repeat) return;
      const track = tracks.find(item => item.hotkey === event.code);
      if (track) {
        event.preventDefault();
        playTrack(track.id);
      }
    }

    async function enableMidi() {
      if (!navigator.requestMIDIAccess) {
        els.midiStatus.textContent = "このブラウザはWeb MIDIに未対応です";
        return;
      }
      try {
        midiAccess = await navigator.requestMIDIAccess();
        midiAccess.inputs.forEach(input => input.onmidimessage = handleMidiMessage);
        midiAccess.onstatechange = () => {
          midiAccess.inputs.forEach(input => input.onmidimessage = handleMidiMessage);
          els.midiStatus.textContent = `MIDI入力: ${midiAccess.inputs.size}`;
        };
        els.midiStatus.textContent = `MIDI入力: ${midiAccess.inputs.size}`;
      } catch {
        els.midiStatus.textContent = "MIDIを有効化できませんでした";
      }
    }

    function handleMidiMessage(message) {
      const [statusByte, data1, data2] = message.data;
      const command = statusByte & 0xf0;
      if (command !== 0x90 && command !== 0xb0) return;
      if (command === 0x90 && data2 === 0) return;
      const signature = `${command === 0x90 ? "NOTE" : "CC"}:${data1}`;
      if (learningMidiId) {
        const track = tracks.find(item => item.id === learningMidiId);
        if (track) {
          track.midi = signature;
          learningMidiId = null;
          saveState();
          render();
          status(`MIDI ${signature} を登録しました`);
        }
        return;
      }
      const track = tracks.find(item => item.midi === signature);
      if (track) playTrack(track.id);
    }



    function applyPan(value) {
      if (audioNodes.active.panner) {
        audioNodes.active.panner.pan.value = clamp(Number(value) || 0, -1, 1);
      }
    }

    function status(message) {
      els.saveStatus.textContent = message;
      els.importStatus.textContent = message;
    }

    function downloadJson(data, filename) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      downloadBlob(blob, filename);
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    function dataUrlToBlob(dataUrl) {
      const [meta, base64] = dataUrl.split(",");
      const type = /data:(.*?);base64/.exec(meta)?.[1] || "application/octet-stream";
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type });
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    function formatBytes(bytes) {
      if (!bytes) return "0 B";
      const units = ["B", "KB", "MB", "GB"];
      const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
    }

    function formatTime(seconds) {
      const safe = Math.max(0, seconds || 0);
      const minutes = Math.floor(safe / 60);
      const secs = Math.floor(safe % 60);
      const tenth = Math.floor((safe % 1) * 10);
      return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${tenth}`;
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, Number(value) || 0));
    }

    function dateStamp() {
      return new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    }