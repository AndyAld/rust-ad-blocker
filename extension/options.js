document.addEventListener('DOMContentLoaded', function () {
  const filterListContainer = document.getElementById('filterListContainer');
  const addCustomListBtn = document.getElementById('addCustomListBtn');
  const customListUrlInput = document.getElementById('customListUrl');
  const updateAllBtn = document.getElementById('updateAllBtn');
  const clearStatsBtn = document.getElementById('clearStatsBtn');
  const toast = document.getElementById('toast');

  // ── Load stats ───────────────────────────────────────────────────────
  chrome.runtime.sendMessage({ action: 'getStats' }, function (response) {
    if (chrome.runtime.lastError || !response) return;

    document.getElementById('blockedToday').textContent = (response.blockedToday || 0).toLocaleString();
    document.getElementById('totalBlocked').textContent = (response.totalBlocked || 0).toLocaleString();
    document.getElementById('networkFilters').textContent = (response.networkFilters || 0).toLocaleString();
    document.getElementById('cosmeticFilters').textContent = (response.cosmeticFilters || 0).toLocaleString();

    // Update privacy setting toggles
    if (response.settings) {
      document.querySelectorAll('[data-setting]').forEach(toggle => {
        const key = toggle.dataset.setting;
        if (response.settings[key] !== undefined) {
          toggle.checked = response.settings[key];
        }
      });
    }
  });

  // ── Load filter lists ────────────────────────────────────────────────
  loadFilterLists();

  function loadFilterLists() {
    chrome.runtime.sendMessage({ action: 'getFilterListStats' }, function (response) {
      if (chrome.runtime.lastError || !response || !response.lists) {
        filterListContainer.textContent = 'Could not load filter lists.';
        return;
      }

      filterListContainer.innerHTML = '';
      for (const list of response.lists) {
        const item = document.createElement('div');
        item.className = 'filter-list-item';

        const lastUpdated = list.lastUpdated
          ? new Date(list.lastUpdated).toLocaleDateString()
          : 'Never';

        item.innerHTML = `
          <div class="info">
            <div class="title">${escapeHtml(list.title)}</div>
            <div class="desc">${escapeHtml(list.description)}</div>
            <div class="meta">${list.lineCount.toLocaleString()} rules · Updated: ${lastUpdated}${list.isCustom
            ? ' · <a href="#" class="remove-list" data-id="' + escapeHtml(list.id) + '" style="color:#f87171;text-decoration:none;">Remove</a>'
            : ''
          }</div>
          </div>
          <label class="toggle">
            <input type="checkbox" class="list-toggle" data-list-id="${escapeHtml(list.id)}" ${list.enabled ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
        `;

        filterListContainer.appendChild(item);
      }

      // Attach toggle listeners
      document.querySelectorAll('.list-toggle').forEach(toggle => {
        toggle.addEventListener('change', function () {
          const id = this.dataset.listId;
          const enabled = this.checked;
          chrome.runtime.sendMessage(
            { action: 'toggleFilterList', id: id, enabled: enabled },
            function () { showToast('Filter list updated', 'success'); }
          );
        });
      });

      // Attach remove listeners
      document.querySelectorAll('.remove-list').forEach(link => {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          const id = this.dataset.id;
          chrome.runtime.sendMessage(
            { action: 'removeCustomFilterList', id: id },
            function () {
              showToast('Custom list removed', 'success');
              loadFilterLists();
            }
          );
        });
      });
    });
  }

  // ── Add custom filter list ───────────────────────────────────────────
  addCustomListBtn.addEventListener('click', function () {
    const url = customListUrlInput.value.trim();
    if (!url) return;

    chrome.runtime.sendMessage(
      { action: 'addCustomFilterList', url: url, title: url },
      function (response) {
        if (response && response.success) {
          showToast('Custom list added', 'success');
          customListUrlInput.value = '';
          loadFilterLists();
        } else {
          showToast('Failed to add list', 'error');
        }
      }
    );
  });

  // ── Update all lists ─────────────────────────────────────────────────
  updateAllBtn.addEventListener('click', function () {
    updateAllBtn.textContent = '⟳ Updating...';
    updateAllBtn.disabled = true;

    chrome.runtime.sendMessage({ action: 'updateFilterLists' }, function (response) {
      updateAllBtn.textContent = '⟳ Update All Lists';
      updateAllBtn.disabled = false;

      if (response && response.success) {
        showToast('All filter lists updated', 'success');
        loadFilterLists();
        // Refresh filter counts
        chrome.runtime.sendMessage({ action: 'getStats' }, function (r) {
          if (r) {
            document.getElementById('networkFilters').textContent = (r.networkFilters || 0).toLocaleString();
            document.getElementById('cosmeticFilters').textContent = (r.cosmeticFilters || 0).toLocaleString();
          }
        });
      } else {
        showToast('Update failed', 'error');
      }
    });
  });

  // ── Clear stats ──────────────────────────────────────────────────────
  clearStatsBtn.addEventListener('click', function () {
    chrome.storage.local.set({ blockedToday: 0, totalBlocked: 0 }, function () {
      document.getElementById('blockedToday').textContent = '0';
      document.getElementById('totalBlocked').textContent = '0';
      showToast('Statistics cleared', 'success');
    });
  });

  // ── Privacy setting toggles ──────────────────────────────────────────
  document.querySelectorAll('[data-setting]').forEach(toggle => {
    toggle.addEventListener('change', function () {
      const key = this.dataset.setting;
      const settings = {};
      settings[key] = this.checked;

      chrome.runtime.sendMessage(
        { action: 'updateSettings', settings: settings },
        function () {
          showToast('Setting updated', 'success');
        }
      );
    });
  });

  // ── Toast notification ───────────────────────────────────────────────
  function showToast(message, type) {
    toast.textContent = message;
    toast.className = 'toast show ' + type;
    setTimeout(() => { toast.className = 'toast'; }, 2500);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
});
