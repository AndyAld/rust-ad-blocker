document.addEventListener('DOMContentLoaded', function() {
  const rulesTextarea = document.getElementById('rulesTextarea');
  const saveButton = document.getElementById('saveButton');
  const resetButton = document.getElementById('resetButton');
  const statusDiv = document.getElementById('status');
  const blockedTodaySpan = document.getElementById('blockedToday');
  const totalBlockedSpan = document.getElementById('totalBlocked');
  const clearStatsButton = document.getElementById('clearStatsButton');
  
  // Default ruleset
  const DEFAULT_RULES = {
    filter_rules: [
      "googleads.g.doubleclick.net",
      "pagead2.googlesyndication.com",
      "tpc.googlesyndication.com",
      "securepubads.g.doubleclick.net"
    ],
    regex_rules: [
      ".*\\.doubleclick\\.net/.*",
      ".*\\.googlesyndication\\.com/.*",
      ".*\\.google-analytics\\.com/.*",
      ".*\\.adnxs\\.com/.*",
      ".*\\.facebook\\.com/tr/.*"
    ],
    domain_rules: {
      "ads.example.com": true,
      "analytics.example.com": true
    }
  };
  
  // Load current rules
  chrome.storage.local.get(['adBlockerRules'], function(result) {
    if (result.adBlockerRules) {
      rulesTextarea.value = result.adBlockerRules;
    } else {
      rulesTextarea.value = JSON.stringify(DEFAULT_RULES, null, 2);
    }
  });
  
  // Load stats
  chrome.storage.local.get(['blockedToday', 'totalBlocked'], function(result) {
    blockedTodaySpan.textContent = result.blockedToday || 0;
    totalBlockedSpan.textContent = result.totalBlocked || 0;
  });
  
  // Save rules
  saveButton.addEventListener('click', function() {
    try {
      // Validate JSON
      const rules = JSON.parse(rulesTextarea.value);
      
      // Save to storage
      chrome.storage.local.set({ 'adBlockerRules': rulesTextarea.value }, function() {
        // Send message to background script
        chrome.runtime.sendMessage(
          { action: 'updateRules', rules: rulesTextarea.value },
          function(response) {
            if (response && response.success) {
              showStatus('Rules saved successfully!', 'success');
            } else {
              showStatus('Error: ' + (response.error || 'Unknown error'), 'error');
            }
          }
        );
      });
    } catch (e) {
      showStatus('Error: Invalid JSON format', 'error');
    }
  });
  
  // Reset to default
  resetButton.addEventListener('click', function() {
    rulesTextarea.value = JSON.stringify(DEFAULT_RULES, null, 2);
  });
  
  // Clear stats
  clearStatsButton.addEventListener('click', function() {
    chrome.storage.local.set({ 'blockedToday': 0, 'totalBlocked': 0 }, function() {
      blockedTodaySpan.textContent = 0;
      totalBlockedSpan.textContent = 0;
      showStatus('Statistics cleared', 'success');
    });
  });
  
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
    statusDiv.style.display = 'block';
    
    setTimeout(function() {
      statusDiv.style.display = 'none';
    }, 3000);
  }
});
