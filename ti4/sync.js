/* sync.js — Multi-player sync layer for Extracomputer
 *
 * Responsibilities:
 *  1. Connect to the Flask-SocketIO server.
 *  2. Override fctSaveItem / fctLoadItem so every state write is broadcast
 *     to all other clients and every client has an up-to-date localStorage.
 *  3. Show a player-selection modal for non-admin visitors.
 *  4. Guard player-specific actions so each client can only act on behalf
 *     of their own faction.
 */

/* jshint esversion: 5 */
/* global io, factionList, strategyList, gVotingPlayer, gActivePlayer,
          gSetupNbPlayer, gActivePhase, PHASE_ACTION, PHASE_STRATEGY,
          PHASE_AGENDA, fctLoadGame, fctSaveItem, fctLoadItem,
          fctStrategyFrame, FctAction, fctResolveAction,
          FctSelectVote, FctKeypadInput */

var gMyRole       = null;   // "admin" | "player"
var gMyPlayerIdx  = -1;     // -1 = not yet assigned; 0-7 = assigned player
var gMyFaction    = null;   // faction name string
var gSocket       = null;
var gStateCache   = {};     // server state mirror
var gIsGameRunning = false; // true once NEKROVIRUS key exists in state

var _syncClaimedFactions = {};

// ---------------------------------------------------------------------------
// Initialise — called after all game scripts have loaded
// ---------------------------------------------------------------------------
function syncInit() {
    var serverUrl = window.location.protocol + "//" + window.location.host;
    gSocket = io(serverUrl);

    gSocket.on("connect", function () {
        _syncShowRoleIndicator("Connecting…");
    });

    gSocket.on("disconnect", function () {
        _syncShowRoleIndicator("DISCONNECTED — reconnecting…");
    });

    // Server sends this once when we first connect
    gSocket.on("init", function (data) {
        gMyRole = data.role;
        gStateCache = data.state || {};
        _syncClaimedFactions = data.player_claims || {};

        // Populate localStorage from server state so the game JS can read it
        for (var key in gStateCache) {
            if (Object.prototype.hasOwnProperty.call(gStateCache, key)) {
                localStorage.setItem(key, gStateCache[key]);
            }
        }

        gIsGameRunning =
            localStorage.getItem("NEKROVIRUS") === "010000100101010101000111";

        if (gMyRole === "admin") {
            _syncShowRoleIndicator("Admin");
            // If a game was already in progress enable the continue button
            if (gIsGameRunning) {
                var btn = document.getElementById("idContinueButton");
                if (btn) btn.disabled = false;
            }
        } else {
            // Install action guards for non-admin players
            _syncInstallGuards();

            if (gIsGameRunning) {
                _syncShowPlayerSelectModal();
            } else {
                _syncShowWaitingScreen();
            }
        }

        // Override storage functions now that we know the role
        _syncOverrideStorage();
    });

    // Another client changed a single state key
    gSocket.on("stateUpdate", function (data) {
        localStorage.setItem(data.key, data.value);
        gStateCache[data.key] = data.value;

        if (gMyRole === "admin") return;

        // Keep VP bar live for non-admin clients
        if (/^VP\d+$/.test(data.key)) {
            _syncRefreshVP();
        }

        // NEKROVIRUS is the LAST key written by fctSaveGame()
        // Use it as a trigger to reload the full game UI
        if (data.key === "NEKROVIRUS") {
            if (!gIsGameRunning) {
                gIsGameRunning = true;
                if (gMyPlayerIdx !== -1) {
                    _syncEnterGame();
                } else {
                    _syncShowPlayerSelectModal();
                }
            } else {
                _syncReloadGameState();
            }
        }

        _syncRefreshPlayerModalIfOpen();
    });

    // A player claimed or released a faction
    gSocket.on("playerUpdate", function (data) {
        if (data.claimed) {
            _syncClaimedFactions[data.faction] = { player_idx: data.player_idx };
        } else {
            delete _syncClaimedFactions[data.faction];
        }
        _syncRefreshPlayerModalIfOpen();
    });

    // Server reply to our claimPlayer request
    gSocket.on("claimResult", function (data) {
        if (data.success) {
            gMyFaction    = data.faction;
            gMyPlayerIdx  = data.player_idx;
            _syncHideModal();
            _syncShowRoleIndicator(data.faction);
            if (gIsGameRunning) {
                _syncEnterGame();
            }
        } else {
            alert("Cannot claim faction: " + data.message);
        }
    });
}

// ---------------------------------------------------------------------------
// Override localStorage wrappers
// ---------------------------------------------------------------------------
function _syncOverrideStorage() {
    window.fctSaveItem = function (key, value) {
        localStorage.setItem(key, value);
        gStateCache[key] = value;
        if (gSocket && gSocket.connected) {
            gSocket.emit("saveItem", { key: key, value: value });
        }
    };
    // fctLoadItem reads localStorage, which is kept in sync — no change needed
}

// ---------------------------------------------------------------------------
// Enter / reload game UI (for non-admin clients)
// ---------------------------------------------------------------------------
function _syncEnterGame() {
    var startScreen = document.getElementById("idStartScreen");
    if (startScreen && startScreen.style.display !== "none") {
        startScreen.style.display = "none";
        var header = document.getElementsByClassName("header");
        if (header.length) header[0].style.display = "flex";
        var nav = document.getElementsByClassName("clNavBar");
        if (nav.length) nav[0].style.display = "block";
    }
    fctLoadGame();
}

function _syncReloadGameState() {
    // Only reload if the game screen is already visible
    var startScreen = document.getElementById("idStartScreen");
    if (startScreen && startScreen.style.display !== "none") {
        // Game just started — enter it
        if (gMyPlayerIdx !== -1) {
            _syncEnterGame();
        }
        return;
    }
    fctLoadGame();
}

// ---------------------------------------------------------------------------
// VP live refresh
// ---------------------------------------------------------------------------
function _syncRefreshVP() {
    var clVPCount = document.getElementsByClassName("clVPCount");
    for (var i = 0; i < clVPCount.length; i++) {
        var v = localStorage.getItem("VP" + i);
        if (v !== null && clVPCount[i]) {
            clVPCount[i].textContent = (parseInt(v, 10) || 0).pad(2);
        }
    }
}

// ---------------------------------------------------------------------------
// Player-action guards (non-admin only)
// ---------------------------------------------------------------------------
function _syncInstallGuards() {
    var _origStrategyFrame  = window.fctStrategyFrame;
    var _origFctAction      = window.FctAction;
    var _origResolveAction  = window.fctResolveAction;
    var _origSelectVote     = window.FctSelectVote;
    var _origKeypadInput    = window.FctKeypadInput;

    // Strategy phase — picking a strategy card
    window.fctStrategyFrame = function (evt) {
        if (!_syncCanAct(gActivePlayer)) {
            _syncShowNotYourTurn();
            return;
        }
        _origStrategyFrame(evt);
    };

    // Action phase — choosing action type (Strategy/Tactical/Pass)
    window.FctAction = function (el) {
        var activePlayer = strategyList[gActivePlayer][STRATEGY_PLAYER];
        if (!_syncCanAct(activePlayer)) {
            _syncShowNotYourTurn();
            return;
        }
        _origFctAction(el);
    };

    // Action phase — "Next player" / resolve button
    window.fctResolveAction = function () {
        var activePlayer = strategyList[gActivePlayer][STRATEGY_PLAYER];
        if (!_syncCanAct(activePlayer)) {
            _syncShowNotYourTurn();
            return;
        }
        _origResolveAction();
    };

    // Voting phase — select a vote option
    window.FctSelectVote = function (evt) {
        if (!_syncCanAct(gVotingPlayer)) {
            _syncShowNotYourTurn();
            return;
        }
        _origSelectVote(evt);
    };

    // Voting phase — enter influence / confirm vote
    window.FctKeypadInput = function (input) {
        if (!_syncCanAct(gVotingPlayer)) {
            _syncShowNotYourTurn();
            return;
        }
        _origKeypadInput(input);
    };
}

// Returns true if the current client is allowed to act for playerIdx
function _syncCanAct(playerIdx) {
    if (gMyRole === "admin") return true;
    if (gMyPlayerIdx === -1) return false;   // not yet assigned a faction
    return gMyPlayerIdx === playerIdx;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function _syncShowRoleIndicator(text) {
    var el = document.getElementById("idSyncRoleIndicator");
    if (!el) {
        el = document.createElement("div");
        el.id = "idSyncRoleIndicator";
        el.style.cssText =
            "position:fixed;bottom:6px;left:6px;" +
            "background:rgba(0,0,0,0.72);color:#c0a060;" +
            "padding:4px 10px;border-radius:3px;z-index:9998;" +
            "font-family:Electrolize,sans-serif;font-size:11px;" +
            "border:1px solid #c0a060;pointer-events:none;";
        document.body.appendChild(el);
    }
    el.textContent = "\u25c8 " + text;
}

function _syncShowNotYourTurn() {
    var el = document.getElementById("idSyncNotYourTurn");
    if (!el) {
        el = document.createElement("div");
        el.id = "idSyncNotYourTurn";
        el.style.cssText =
            "position:fixed;top:50%;left:50%;" +
            "transform:translate(-50%,-50%);" +
            "background:rgba(0,0,0,0.90);color:#ff6060;" +
            "padding:20px 36px;border-radius:6px;z-index:9999;" +
            "font-family:Audiowide,sans-serif;font-size:18px;" +
            "border:1px solid #ff6060;text-align:center;" +
            "pointer-events:none;";
        document.body.appendChild(el);
    }
    el.textContent = "NOT YOUR TURN";
    el.style.display = "block";
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.display = "none"; }, 2000);
}

// ---------------------------------------------------------------------------
// Player-selection modal
// ---------------------------------------------------------------------------
function _syncGetOrCreateModal() {
    var modal = document.getElementById("idSyncPlayerModal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "idSyncPlayerModal";
        modal.style.cssText =
            "position:fixed;top:0;left:0;width:100%;height:100%;" +
            "background:rgba(0,0,0,0.88);z-index:10000;" +
            "display:flex;align-items:center;justify-content:center;";
        document.body.appendChild(modal);
    }
    return modal;
}

function _syncShowWaitingScreen() {
    var modal = _syncGetOrCreateModal();
    modal.innerHTML =
        "<div style=\"background:#1a1a2e;color:#c0a060;padding:40px;" +
        "border-radius:8px;border:1px solid #c0a060;max-width:480px;" +
        "width:90%;text-align:center;\">" +
        "<img src=\"ti4/img/tilogo.png\" style=\"max-width:180px;\"><br><br>" +
        "<h2 style=\"font-family:Audiowide,sans-serif;\">Waiting for Admin</h2>" +
        "<p style=\"font-family:Electrolize,sans-serif;color:#aaa;\">" +
        "The game has not started yet.<br>" +
        "Please wait for the admin to set up the game.</p>" +
        "<div style=\"font-size:28px;color:#c0a060;margin-top:20px;\">· · ·</div>" +
        "</div>";
    modal.style.display = "flex";
}

function _syncShowPlayerSelectModal() {
    var modal = _syncGetOrCreateModal();
    _syncBuildPlayerModalContent(modal);
    modal.style.display = "flex";
}

function _syncBuildPlayerModalContent(modal) {
    if (!modal) modal = document.getElementById("idSyncPlayerModal");
    if (!modal) return;

    var nbPlayers = parseInt(localStorage.getItem("gSetupNbPlayer"), 10) || 0;

    var html =
        "<div style=\"background:#1a1a2e;color:#c0a060;padding:40px;" +
        "border-radius:8px;border:1px solid #c0a060;max-width:600px;" +
        "width:90%;text-align:center;\">" +
        "<img src=\"ti4/img/tilogo.png\" style=\"max-width:150px;\"><br><br>" +
        "<h2 style=\"font-family:Audiowide,sans-serif;margin-bottom:8px;\">Who are you?</h2>" +
        "<p style=\"font-family:Electrolize,sans-serif;color:#aaa;margin-bottom:24px;\">" +
        "Select your faction to join the game</p>";

    if (nbPlayers === 0) {
        html +=
            "<p style=\"font-family:Electrolize,sans-serif;\">Waiting for admin to start the game&hellip;</p>" +
            "<button onclick=\"_syncBuildPlayerModalContent()\" " +
            "style=\"margin-top:20px;padding:10px 24px;background:transparent;" +
            "color:#c0a060;border:1px solid #c0a060;cursor:pointer;" +
            "font-family:Audiowide,sans-serif;border-radius:3px;\">Refresh</button>";
    } else {
        html += "<div style=\"display:flex;flex-wrap:wrap;gap:12px;justify-content:center;\">";

        for (var i = 0; i < nbPlayers; i++) {
            var factionIdx = parseInt(localStorage.getItem("gPlayerData" + i + "0"), 10) || 0;
            var factionName = _syncGetFactionName(factionIdx);
            var isClaimed = _syncIsClaimed(i);

            if (isClaimed) {
                html +=
                    "<div style=\"padding:14px 18px;border:1px solid #555;" +
                    "color:#555;border-radius:4px;font-family:Audiowide,sans-serif;" +
                    "font-size:12px;text-align:center;\">" +
                    _syncEscapeHtml(factionName) +
                    "<br><small style=\"font-size:10px;\">(taken)</small></div>";
            } else {
                html +=
                    "<button onclick=\"syncClaimFaction(" + JSON.stringify(factionName) + "," + i + ")\" " +
                    "style=\"padding:14px 18px;border:1px solid #c0a060;" +
                    "background:#2a2a4a;color:#c0a060;cursor:pointer;" +
                    "border-radius:4px;font-family:Audiowide,sans-serif;font-size:12px;\">" +
                    _syncEscapeHtml(factionName) + "</button>";
            }
        }
        html += "</div>";
    }
    html += "</div>";
    modal.innerHTML = html;
}

function syncClaimFaction(factionName, playerIdx) {
    if (gSocket && gSocket.connected) {
        gSocket.emit("claimPlayer", { faction: factionName, player_idx: playerIdx });
    }
}

function _syncHideModal() {
    var modal = document.getElementById("idSyncPlayerModal");
    if (modal) modal.style.display = "none";
}

function _syncRefreshPlayerModalIfOpen() {
    var modal = document.getElementById("idSyncPlayerModal");
    if (modal && modal.style.display !== "none" && gMyPlayerIdx === -1) {
        _syncBuildPlayerModalContent(modal);
    }
}

function _syncIsClaimed(playerIdx) {
    for (var f in _syncClaimedFactions) {
        if (Object.prototype.hasOwnProperty.call(_syncClaimedFactions, f)) {
            if (_syncClaimedFactions[f] && _syncClaimedFactions[f].player_idx === playerIdx) {
                return true;
            }
        }
    }
    return false;
}

function _syncGetFactionName(factionIdx) {
    if (typeof factionList !== "undefined" && factionList[factionIdx]) {
        return factionList[factionIdx][0];  // index 0 = English name
    }
    return "Player " + factionIdx;
}

function _syncEscapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Boot — run after all other scripts have loaded
// ---------------------------------------------------------------------------
function _syncBoot() {
    // io() may not be available yet if the socket.io script is still loading;
    // keep retrying until it appears (typically < 1 s)
    if (typeof io === "undefined") {
        setTimeout(_syncBoot, 100);
        return;
    }
    syncInit();
}

window.addEventListener("load", function () {
    setTimeout(_syncBoot, 50);
});
