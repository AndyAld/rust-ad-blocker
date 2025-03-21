document.addEventListener('DOMContentLoaded', function() {
  const statusDiv = document.getElementById('status');
  const toggleButton = document.getElementById('toggleButton');
  const optionsButton = document.getElementById('optionsButton');
  const blockedCountSpan = document.getElementById('blockedCount');
  const totalBlockedSpan = document.getElementById('totalBlocked');
  
  // Get stats from background page
  chrome.runtime.sendMessage({ action: "getStats" }, function(response) {
    if (response) {
      updateUI(response.enabled, response.blockedToday, response.totalBlocked);
    } else {
      // Fallback to storage if background page is not ready
      chrome.storage.local.get(['enabled', 'blockedToday', 'totalBlocked'], function(result) {
        const enabled = result.enabled === undefined ? true : result.enabled;
        const blockedToday = result.blockedToday || 0;
        const totalBlocked = result.totalBlocked || 0;
        
        updateUI(enabled, blockedToday, totalBlocked);
      });
    }
  });
  
  function updateUI(enabled, blockedToday, totalBlocked) {
    if (enabled) {
      statusDiv.className = 'status enabled';
      statusDiv.textContent = 'Ad blocking is enabled';
      toggleButton.textContent = 'Disable';
      toggleButton.className = '';
    } else {
      statusDiv.className = 'status disabled';
      statusDiv.textContent = 'Ad blocking is disabled';
      toggleButton.textContent = 'Enable';
      toggleButton.className = 'disabled';
    }
    
    blockedCountSpan.textContent = blockedToday;
    totalBlockedSpan.textContent = totalBlocked;
  }
  
  toggleButton.addEventListener('click', function() {
    chrome.storage.local.get(['enabled'], function(result) {
      const enabled = result.enabled === undefined ? true : result.enabled;
      const newEnabled = !enabled;
      
      chrome.storage.local.set({ 'enabled': newEnabled }, function() {
        chrome.storage.local.get(['blockedToday', 'totalBlocked'], function(result) {
          updateUI(newEnabled, result.blockedToday || 0, result.totalBlocked || 0);
        });
      });
      
      // Send message to background script
      chrome.runtime.sendMessage({ action: 'toggleEnabled', enabled: newEnabled });
    });
  });
  
  optionsButton.addEventListener('click', function() {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL('options.html'));
    }
  });
});
