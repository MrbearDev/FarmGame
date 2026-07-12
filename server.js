const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

let minecraftProcess = null;
let serverStatus = 'stopped'; // stopped, starting, running
let serverLogs = [];
const MAX_LOGS = 1000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Save config helper
function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// Log helper to add logs and broadcast
function appendLog(line) {
  serverLogs.push(line);
  if (serverLogs.length > MAX_LOGS) {
    serverLogs.shift();
  }
  broadcast({ type: 'log', data: line });
}

// Broadcast to WS clients
function broadcast(msg) {
  const payload = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Helper to copy selected minigame plugin
function preparePlugin() {
  const selectedGameId = config.selectedGame;
  const game = config.games.find(g => g.id === selectedGameId);
  if (!game || game.locked || !game.jarName) {
    appendLog(`[Launcher] Game '${selectedGameId}' is locked or has no jar file.`);
    return;
  }

  const pluginsDir = path.join(config.serverPath, 'plugins');
  if (!fs.existsSync(pluginsDir)) {
    fs.mkdirSync(pluginsDir, { recursive: true });
  }

  // Delete other minigames jars in target directory to avoid conflicts
  config.games.forEach(g => {
    if (g.jarName) {
      const oldJarPath = path.join(pluginsDir, g.jarName);
      if (fs.existsSync(oldJarPath)) {
        try {
          fs.unlinkSync(oldJarPath);
          appendLog(`[Launcher] Removed old plugin: ${g.jarName}`);
        } catch (err) {
          appendLog(`[Launcher] Error removing ${g.jarName}: ${err.message}`);
        }
      }
    }
  });

  // Copy new plugin jar
  const srcJarPath = path.join(__dirname, 'minigames', selectedGameId, game.jarName);
  const destJarPath = path.join(pluginsDir, game.jarName);

  if (fs.existsSync(srcJarPath)) {
    try {
      fs.copyFileSync(srcJarPath, destJarPath);
      appendLog(`[Launcher] Copied selected plugin: ${game.jarName} to plugins directory.`);
    } catch (err) {
      appendLog(`[Launcher] Error copying plugin jar: ${err.message}`);
    }
  } else {
    appendLog(`[Launcher] Source plugin jar not found at ${srcJarPath}`);
  }
}

// Start Server Process
function startMinecraftServer() {
  if (minecraftProcess) {
    appendLog('[Launcher] Server is already running.');
    return;
  }

  serverStatus = 'starting';
  broadcast({ type: 'status', data: serverStatus });
  appendLog('[Launcher] Preparing plugins for selected game...');
  preparePlugin();

  appendLog('[Launcher] Starting Folia Minecraft server...');
  
  const args = [
    `-Xmx${config.ramAllocation}`,
    `-Xms${config.ramAllocation}`,
    '-jar',
    config.serverJar,
    'nogui'
  ];

  try {
    minecraftProcess = spawn(config.javaPath, args, {
      cwd: config.serverPath,
      shell: true
    });

    minecraftProcess.stdout.on('data', (data) => {
      const text = data.toString();
      text.split(/\r?\n/).forEach(line => {
        if (line.trim()) {
          appendLog(line);
          // Detect when server is done loading
          if (line.includes('] Done (') || line.includes('For help, type "help"')) {
            serverStatus = 'running';
            broadcast({ type: 'status', data: serverStatus });
          }
        }
      });
    });

    minecraftProcess.stderr.on('data', (data) => {
      const text = data.toString();
      text.split(/\r?\n/).forEach(line => {
        if (line.trim()) {
          appendLog(`[ERROR] ${line}`);
        }
      });
    });

    minecraftProcess.on('close', (code) => {
      appendLog(`[Launcher] Server process exited with code ${code}`);
      minecraftProcess = null;
      serverStatus = 'stopped';
      broadcast({ type: 'status', data: serverStatus });
    });

    minecraftProcess.on('error', (err) => {
      appendLog(`[Launcher] Failed to start server process: ${err.message}`);
      minecraftProcess = null;
      serverStatus = 'stopped';
      broadcast({ type: 'status', data: serverStatus });
    });

  } catch (err) {
    appendLog(`[Launcher] Spawn error: ${err.message}`);
    serverStatus = 'stopped';
    broadcast({ type: 'status', data: serverStatus });
  }
}

// Stop Server Process
function stopMinecraftServer() {
  if (!minecraftProcess) {
    appendLog('[Launcher] Server is not running.');
    return;
  }

  appendLog('[Launcher] Sending stop command to server...');
  sendConsoleCommand('stop');

  // Force kill if it hangs
  setTimeout(() => {
    if (minecraftProcess) {
      appendLog('[Launcher] Server process taking too long to close, force terminating...');
      minecraftProcess.kill('SIGKILL');
    }
  }, 15000);
}

// Send Console Command
function sendConsoleCommand(cmd) {
  if (minecraftProcess && minecraftProcess.stdin) {
    try {
      minecraftProcess.stdin.write(cmd + '\n');
      appendLog(`> ${cmd}`);
    } catch (err) {
      appendLog(`[Launcher] Error writing to console: ${err.message}`);
    }
  } else {
    appendLog(`[Launcher] Command cannot be executed. Server is offline.`);
  }
}

// Discord Auth Endpoints
app.get('/auth/discord', (req, res) => {
  const clientId = config.discordClientId;
  if (!clientId) {
    // Simulation Mode
    appendLog('[Launcher] Discord Client ID not set. Running in developer simulation mode...');
    return res.redirect('/auth/discord/callback?code=mock_code');
  }

  const redirectUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(config.discordRedirectUri)}&response_type=code&scope=identify`;
  res.redirect(redirectUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authorization code not provided.');
  }

  if (code === 'mock_code' || !config.discordClientId) {
    // Simulated logged-in user session
    config.userSession = {
      id: "123456789",
      username: "bearzeno",
      globalName: "RAY",
      avatarUrl: "assets/maki5.png",
      mock: true
    };
    saveConfig();
    appendLog('[Launcher] Successfully logged in (Simulation Mode) as RAY (@bearzeno).');
    return res.redirect('/');
  }

  // Real Discord OAuth2 code exchange using Native Fetch
  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: config.discordClientId,
        client_secret: config.discordClientSecret,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: config.discordRedirectUri,
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error);
    }

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const userData = await userResponse.json();

    // Access check (Owner bypasses, others check selected game lock and whitelist)
    const isOwner = userData.id === "1478757367469445212";
    if (!isOwner) {
      const game = config.games.find(g => g.id === config.selectedGame);
      const isGameLocked = game ? game.locked : false;
      const gameWhitelist = game ? (game.whitelist || []) : [];
      
      if (isGameLocked || !gameWhitelist.includes(userData.id)) {
        appendLog(`[Launcher] Access denied for Discord user ${userData.global_name || userData.username} (ID: ${userData.id}) - Game is locked or user not whitelisted.`);
        return res.status(403).send(`
          <html>
            <head>
              <title>Access Denied</title>
              <style>
                body { background: #121214; color: #f97316; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .card { background: #1a1a1e; padding: 30px; border-radius: 12px; border: 1px solid #f97316; text-align: center; max-width: 400px; box-shadow: 0 0 20px rgba(249, 115, 22, 0.2); }
                h1 { color: #f97316; margin-top: 0; }
                p { color: #a1a1aa; line-height: 1.6; }
                a { color: #eab308; text-decoration: none; font-weight: bold; }
              </style>
            </head>
            <body>
              <div class="card">
                <h1>Access Denied ❌</h1>
                <p>Sorry, you do not have permission to access the active game launcher (<b>${game ? game.name : 'Unknown'}</b>).</p>
                <p>Please ask the Server Owner (Discord ID: <code>1478757367469445212</code>) to whitelist you.</p>
                <br>
                <a href="/">Go Back to Login</a>
              </div>
            </body>
          </html>
        `);
      }
    }

    config.userSession = {
      id: userData.id,
      username: userData.username,
      globalName: userData.global_name || userData.username,
      avatarUrl: userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png` : `https://api.dicebear.com/7.x/adventurer/svg?seed=${userData.username}`
    };
    saveConfig();
    appendLog(`[Launcher] Successfully logged in via Discord as ${config.userSession.globalName} (@${config.userSession.username}).`);
    res.redirect('/');
  } catch (err) {
    appendLog(`[Launcher] Discord Login Error: ${err.message}`);
    res.status(500).send(`Discord Authentication Failed: ${err.message}`);
  }
});

app.post('/api/logout', (req, res) => {
  config.userSession = null;
  saveConfig();
  appendLog('[Launcher] User logged out.');
  res.json({ success: true });
});

// REST API Endpoints
app.get('/api/server/packs', (req, res) => {
  const packs = config.games.map(g => ({
    id: g.id,
    name: g.name,
    version: g.version,
    descriptionMDTh: `### ${g.name} (v${g.version})\n${g.description}\n\n**Minecraft Client Version:** MC ${g.mcVersion || '1.21.4'}\n`,
    descriptionMDEn: `### ${g.name} (v${g.version})\n${g.description}\n\n**Minecraft Client Version:** MC ${g.mcVersion || '1.21.4'}\n`,
    whitelisted: true,
    remainingDays: 99,
    updatedAt: new Date().toISOString(),
    locked: g.locked
  }));
  res.json({ success: true, data: packs });
});

app.get('/api/user/profile', (req, res) => {
  if (config.userSession) {
    const isAdmin = config.userSession.id === "1478757367469445212";
    res.json({
      success: true,
      data: {
        discord_id: config.userSession.id,
        username: config.userSession.username,
        display_name: config.userSession.globalName,
        global_name: config.userSession.globalName,
        avatar: config.userSession.avatarUrl.includes('maki5.png') ? '/assets/maki5.png' : config.userSession.avatarUrl,
        isAdmin: isAdmin
      }
    });
  } else {
    res.status(401).json({ success: false, error: 'Unauthorized' });
  }
});

app.get('/api/auth/discord', (req, res) => {
  const clientId = config.discordClientId;
  if (!clientId) {
    return res.json({ success: true, data: { url: '/auth/discord/callback?code=mock_code' } });
  }
  const redirectUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(config.discordRedirectUri)}&response_type=code&scope=identify`;
  res.json({ success: true, data: { url: redirectUrl } });
});

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const { selectedGame, ramAllocation, locked } = req.body;
  if (selectedGame !== undefined) {
    config.selectedGame = selectedGame;
  }
  if (ramAllocation !== undefined) {
    config.ramAllocation = ramAllocation;
  }
  if (locked !== undefined && config.userSession && config.userSession.id === "1478757367469445212") {
    const game = config.games.find(g => g.id === config.selectedGame);
    if (game) {
      game.locked = locked;
    }
  }
  saveConfig();
  res.json({ success: true, config });
});

// Whitelist REST API
app.get('/api/whitelist', (req, res) => {
  if (!config.userSession) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  if (config.userSession.id !== "1478757367469445212") {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const game = config.games.find(g => g.id === config.selectedGame);
  res.json({ success: true, data: (game && game.whitelist) || [] });
});

app.post('/api/whitelist/add', (req, res) => {
  if (!config.userSession) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  if (config.userSession.id !== "1478757367469445212") {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const { id } = req.body;
  if (!id || !/^\d+$/.test(id)) {
    return res.status(400).json({ success: false, error: 'Invalid Discord User ID' });
  }
  const game = config.games.find(g => g.id === config.selectedGame);
  if (game) {
    if (!game.whitelist) {
      game.whitelist = [];
    }
    if (!game.whitelist.includes(id)) {
      game.whitelist.push(id);
      saveConfig();
      appendLog(`[Launcher] Whitelist: Added user ${id} to game ${game.id}`);
    }
    res.json({ success: true, data: game.whitelist });
  } else {
    res.status(404).json({ success: false, error: 'Game not found' });
  }
});

app.post('/api/whitelist/remove', (req, res) => {
  if (!config.userSession) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  if (config.userSession.id !== "1478757367469445212") {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, error: 'Invalid ID' });
  }
  const game = config.games.find(g => g.id === config.selectedGame);
  if (game && game.whitelist) {
    game.whitelist = game.whitelist.filter(wId => wId !== id);
    saveConfig();
    appendLog(`[Launcher] Whitelist: Removed user ${id} from game ${game.id}`);
    res.json({ success: true, data: game.whitelist });
  } else {
    res.json({ success: true, data: [] });
  }
});

app.post('/api/control', (req, res) => {
  const { action } = req.body;
  if (action === 'start') {
    startMinecraftServer();
  } else if (action === 'stop') {
    stopMinecraftServer();
  }
  res.json({ success: true, status: serverStatus });
});

// Helper to check for remote launcher updates from GitHub
function checkUpdates(wsClient = null) {
  const localVer = config.version || '1.2.8';
  
  if (!config.updateCheckUrl) {
    const payload = JSON.stringify({
      type: 'update-status',
      data: { localVersion: localVer, remoteVersion: localVer, updateAvailable: false }
    });
    if (wsClient) wsClient.send(payload);
    return;
  }

  https.get(config.updateCheckUrl, (res) => {
    if (res.statusCode !== 200) {
      console.error(`[Updater] Failed to check updates: Status ${res.statusCode}`);
      return;
    }
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const remoteInfo = JSON.parse(body);
        const remoteVer = remoteInfo.version;
        const updateAvailable = localVer !== remoteVer;
        
        const updateInfo = {
          localVersion: localVer,
          remoteVersion: remoteVer,
          updateAvailable: updateAvailable,
          changelog: remoteInfo.changelog || 'No changelog details provided.',
          downloadUrl: remoteInfo.downloadUrl
        };

        const payload = JSON.stringify({ type: 'update-status', data: updateInfo });
        if (wsClient) {
          wsClient.send(payload);
        } else {
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(payload);
            }
          });
        }
      } catch (e) {
        console.error('[Updater] Error parsing version metadata:', e.message);
      }
    });
  }).on('error', (err) => {
    console.error('[Updater] Network error during update check:', err.message);
  });
}

app.post('/api/update', (req, res) => {
  appendLog('[Launcher] Initializing auto-updater...');
  
  if (!config.updateCheckUrl) {
    return res.status(400).json({ error: 'Update check URL is not configured' });
  }

  https.get(config.updateCheckUrl, (resVer) => {
    if (resVer.statusCode !== 200) {
      appendLog(`[Launcher] [ERROR] Failed to fetch update metadata: Status ${resVer.statusCode}`);
      return res.status(500).json({ error: 'Failed to fetch update metadata' });
    }
    
    let body = '';
    resVer.on('data', chunk => body += chunk);
    resVer.on('end', () => {
      try {
        const remoteInfo = JSON.parse(body);
        const downloadUrl = remoteInfo.downloadUrl;
        const newVersion = remoteInfo.version;

        if (!downloadUrl) {
          appendLog('[Launcher] [ERROR] Update download URL is missing from metadata.');
          return res.status(400).json({ error: 'Update URL is empty' });
        }

        const updateZipPath = path.join(__dirname, 'launcher_update.zip');
        appendLog(`[Launcher] Downloading launcher update v${newVersion}...`);
        
        downloadFile(downloadUrl, updateZipPath,
          (pct) => {
            if (pct % 25 === 0) {
              appendLog(`[Launcher] Downloading update: ${pct}%...`);
            }
          },
          () => {
            appendLog(`[Launcher] Download completed! Extracting update package directly to launcher root...`);
            
            extractZip(updateZipPath, __dirname,
              () => {
                try { fs.unlinkSync(updateZipPath); } catch(e) {}
                config.version = newVersion;
                saveConfig();
                
                appendLog(`[Launcher] Update successfully applied to version ${newVersion}!`);
                appendLog('[Launcher] Launcher will now exit to apply updates...');
                
                res.json({ success: true });
                
                setTimeout(() => {
                  process.exit(0); // Exit process, batch file loop will restart it!
                }, 1500);
              },
              (err) => {
                try { fs.unlinkSync(updateZipPath); } catch(e) {}
                appendLog(`[Launcher] [ERROR] Extraction failed: ${err.message}`);
                res.status(500).json({ error: err.message });
              }
            );
          },
          (err) => {
            appendLog(`[Launcher] [ERROR] Download failed: ${err.message}`);
            res.status(500).json({ error: err.message });
          }
        );
      } catch (e) {
        appendLog(`[Launcher] [ERROR] Failed to parse update payload: ${e.message}`);
        res.status(500).json({ error: e.message });
      }
    });
  }).on('error', (err) => {
    appendLog(`[Launcher] [ERROR] Network connection failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  });
});

// Check if server is installed (jar file exists in path)
function checkServerInstalled(gameId) {
  const game = config.games.find(g => g.id === gameId);
  if (!game) return false;
  const serverPath = game.serverPath || config.serverPath;
  const serverJar = game.serverJar || config.serverJar;
  const jarPath = path.join(serverPath, serverJar);
  return fs.existsSync(jarPath);
}

// Download file with redirect handling
function downloadFile(url, destPath, onProgress, onSuccess, onError) {
  const file = fs.createWriteStream(destPath);
  https.get(url, (response) => {
    if (response.statusCode === 302 || response.statusCode === 301) {
      downloadFile(response.headers.location, destPath, onProgress, onSuccess, onError);
      return;
    }
    if (response.statusCode !== 200) {
      onError(new Error(`Server returned status code ${response.statusCode}`));
      return;
    }
    const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
    let downloadedBytes = 0;
    response.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      file.write(chunk);
      if (totalBytes > 0) {
        const pct = Math.round((downloadedBytes / totalBytes) * 100);
        onProgress(pct);
      }
    });
    response.on('end', () => {
      file.end();
      onSuccess();
    });
  }).on('error', (err) => {
    fs.unlink(destPath, () => {});
    onError(err);
  });
}

// Extract zip using native PowerShell Expand-Archive
function extractZip(zipPath, destDir, onSuccess, onError) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const cmd = `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`;
  const proc = spawn('powershell', ['-Command', cmd], { shell: true });
  proc.on('close', (code) => {
    if (code === 0) {
      onSuccess();
    } else {
      onError(new Error(`Extraction process failed with code ${code}`));
    }
  });
}

app.get('/api/server/check-installed', (req, res) => {
  const { gameId } = req.query;
  if (!gameId) {
    return res.status(400).json({ error: 'gameId is required' });
  }
  const installed = checkServerInstalled(gameId);
  res.json({ success: true, installed });
});

app.post('/api/server/download', (req, res) => {
  const { gameId } = req.body;
  const game = config.games.find(g => g.id === gameId);
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  if (!game.downloadUrl) {
    return res.status(400).json({ error: 'Download URL is not configured for this game' });
  }

  const serverPath = game.serverPath || config.serverPath;
  const tempZipPath = path.join(__dirname, `temp_${gameId}.zip`);

  serverStatus = 'starting'; // Temporarily set starting state during download/extract
  broadcast({ type: 'status', data: serverStatus });
  appendLog(`[Launcher] เริ่มต้นการดาวน์โหลดตัวรันเซิร์ฟเวอร์สำหรับ ${game.name}...`);
  appendLog(`[Launcher] จากลิงก์: ${game.downloadUrl}`);

  downloadFile(game.downloadUrl, tempZipPath, 
    (pct) => {
      broadcast({ type: 'status', data: `downloading (${pct}%)` });
      // Throttle log a bit (only every 20%)
      if (pct % 20 === 0) {
        appendLog(`[Launcher] กำลังดาวน์โหลด: ${pct}%...`);
      }
    },
    () => {
      appendLog(`[Launcher] ดาวน์โหลดเสร็จสิ้น! กำลังแตกไฟล์ไปยัง: ${serverPath}...`);
      broadcast({ type: 'status', data: 'extracting' });
      
      extractZip(tempZipPath, serverPath,
        () => {
          // Success! Clean up temp file
          try { fs.unlinkSync(tempZipPath); } catch(e) {}
          
          const serverJar = game.serverJar || config.serverJar;
          const jarPath = path.join(serverPath, serverJar);
          
          if (game.jarDownloadUrl && !fs.existsSync(jarPath)) {
            appendLog(`[Launcher] กำลังดาวน์โหลดตัวรันเซิร์ฟเวอร์หลัก (${serverJar}) จากทางการ...`);
            broadcast({ type: 'status', data: 'downloading-jar (0%)' });
            
            downloadFile(game.jarDownloadUrl, jarPath,
              (jarPct) => {
                broadcast({ type: 'status', data: `downloading-jar (${jarPct}%)` });
                if (jarPct % 20 === 0) {
                  appendLog(`[Launcher] กำลังดาวน์โหลดตัวรันหลัก: ${jarPct}%...`);
                }
              },
              () => {
                appendLog(`[Launcher] ดาวน์โหลดตัวรันเซิร์ฟเวอร์หลักสำเร็จ!`);
                serverStatus = 'stopped';
                broadcast({ type: 'status', data: serverStatus });
                res.json({ success: true });
              },
              (jarErr) => {
                appendLog(`[Launcher] [ERROR] ดาวน์โหลดตัวรันหลักล้มเหลว: ${jarErr.message}`);
                serverStatus = 'stopped';
                broadcast({ type: 'status', data: serverStatus });
                res.status(500).json({ error: jarErr.message });
              }
            );
          } else {
            appendLog(`[Launcher] แตกไฟล์และติดตั้งเซิร์ฟเวอร์ ${game.name} พร้อมเล่นเรียบร้อยแล้ว`);
            serverStatus = 'stopped';
            broadcast({ type: 'status', data: serverStatus });
            res.json({ success: true });
          }
        },
        (err) => {
          try { fs.unlinkSync(tempZipPath); } catch(e) {}
          appendLog(`[Launcher] [ERROR] การแตกไฟล์ล้มเหลว: ${err.message}`);
          serverStatus = 'stopped';
          broadcast({ type: 'status', data: serverStatus });
          res.status(500).json({ error: err.message });
        }
      );
    },
    (err) => {
      appendLog(`[Launcher] [ERROR] ดาวน์โหลดล้มเหลว: ${err.message}`);
      serverStatus = 'stopped';
      broadcast({ type: 'status', data: serverStatus });
      res.status(500).json({ error: err.message });
    }
  );
});

app.post('/api/command', (req, res) => {
  const { command } = req.body;
  if (!command) {
    return res.status(400).json({ error: 'Command is required' });
  }
  sendConsoleCommand(command);
  res.json({ success: true });
});

// WebSocket Connection Handling
wss.on('connection', (ws) => {
  // Send initial state on connect
  ws.send(JSON.stringify({ type: 'status', data: serverStatus }));
  ws.send(JSON.stringify({ type: 'logs', data: serverLogs }));
  
  // Send update status
  checkUpdates(ws);

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'command') {
        sendConsoleCommand(msg.data);
      }
    } catch (err) {
      console.error('WS parse error:', err.message);
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[Launcher] Backend server running at http://localhost:${PORT}`);
});
