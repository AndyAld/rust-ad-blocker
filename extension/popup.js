document.addEventListener('DOMContentLoaded', function () {
  const statusDiv = document.getElementById('status');
  const toggleButton = document.getElementById('toggleButton');
  const optionsButton = document.getElementById('optionsButton');
  const blockedCountSpan = document.getElementById('blockedCount');
  const totalBlockedSpan = document.getElementById('totalBlocked');
  const filtersInfo = document.getElementById('filtersInfo');

  // Get stats from background
  chrome.runtime.sendMessage({ action: 'getStats' }, function (response) {
    if (chrome.runtime.lastError) {
      console.warn('Could not reach background:', chrome.runtime.lastError.message);
      loadFromStorage();
      return;
    }
    if (response) {
      updateUI(response.enabled, response.blockedToday, response.totalBlocked);
      if (response.networkFilters !== undefined) {
        filtersInfo.textContent =
          `${response.networkFilters.toLocaleString()} network filters · ${response.cosmeticFilters.toLocaleString()} cosmetic filters`;
      }
    } else {
      loadFromStorage();
    }
  });

  function loadFromStorage() {
    chrome.storage.local.get(['enabled', 'blockedToday', 'totalBlocked'], function (result) {
      updateUI(
        result.enabled === undefined ? true : result.enabled,
        result.blockedToday || 0,
        result.totalBlocked || 0
      );
    });
  }

  function updateUI(enabled, blockedToday, totalBlocked) {
    if (enabled) {
      statusDiv.className = 'status-bar enabled';
      statusDiv.textContent = 'Protection Active';
      toggleButton.textContent = 'Disable';
      toggleButton.className = '';
    } else {
      statusDiv.className = 'status-bar disabled';
      statusDiv.textContent = 'Protection Disabled';
      toggleButton.textContent = 'Enable';
      toggleButton.className = 'off';
    }

    blockedCountSpan.textContent = blockedToday.toLocaleString();
    totalBlockedSpan.textContent = totalBlocked.toLocaleString();
  }

  toggleButton.addEventListener('click', function () {
    chrome.storage.local.get(['enabled'], function (result) {
      const current = result.enabled === undefined ? true : result.enabled;
      const newEnabled = !current;

      chrome.storage.local.set({ enabled: newEnabled }, function () {
        chrome.storage.local.get(['blockedToday', 'totalBlocked'], function (result) {
          updateUI(newEnabled, result.blockedToday || 0, result.totalBlocked || 0);
        });
      });

      chrome.runtime.sendMessage(
        { action: 'toggleEnabled', enabled: newEnabled },
        function (response) {
          if (chrome.runtime.lastError) {
            console.warn('Could not reach background:', chrome.runtime.lastError.message);
          }
        }
      );
    });
  });

  optionsButton.addEventListener('click', function () {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });
});
