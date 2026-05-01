#!/usr/bin/env python3
"""
Extracomputer Multi-Player Server
==================================
Serves the Extracomputer TI4 assistant on your local network.

  - The FIRST device to load the page becomes the Admin.
  - Subsequent devices are prompted to select their faction/player.
  - All clients share the same live game state via Socket.IO.
  - Each non-admin player can only take actions on behalf of their faction.

Usage:
    pip install -r requirements.txt
    python3 server.py
"""

import os
import socket
import urllib.request

from flask import Flask, request, send_from_directory
from flask_socketio import SocketIO, emit

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

SOCKETIO_JS_PATH = os.path.join(BASE_DIR, "ti4", "socket.io.min.js")
SOCKETIO_JS_URL = "https://cdn.socket.io/4.7.5/socket.io.min.js"

app = Flask(__name__, static_folder=BASE_DIR)
app.config["SECRET_KEY"] = "extracomputer-ti4-secret"

# threading mode works without extra async dependencies
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ---------------------------------------------------------------------------
# Server state
# ---------------------------------------------------------------------------
game_state: dict = {}      # localStorage mirror — key → value
admin_sid: str | None = None
player_claims: dict = {}   # faction_name → {"sid": str, "player_idx": int}
client_roles: dict = {}    # sid → {"role": "admin"|"player", "player_idx": int|None}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def get_local_ip() -> str:
    """Return the machine's LAN IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return socket.gethostbyname(socket.gethostname())


def ensure_socketio_js() -> None:
    """Download the Socket.IO client library for local serving if missing."""
    if os.path.exists(SOCKETIO_JS_PATH):
        return
    print("  Downloading Socket.IO client library…")
    try:
        urllib.request.urlretrieve(SOCKETIO_JS_URL, SOCKETIO_JS_PATH)
        print("  socket.io.min.js downloaded successfully.")
    except Exception as exc:
        print(f"  Warning: could not download socket.io.min.js ({exc})")
        print("  Browsers will fall back to the CDN URL.")


def public_claims() -> dict:
    """Return player_claims without internal sid information."""
    return {
        faction: {"player_idx": info["player_idx"]}
        for faction, info in player_claims.items()
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "extracomputer.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(BASE_DIR, path)


# ---------------------------------------------------------------------------
# Socket.IO events
# ---------------------------------------------------------------------------
@socketio.on("connect")
def on_connect():
    global admin_sid
    sid = request.sid

    if admin_sid is None:
        admin_sid = sid
        role = "admin"
    else:
        role = "player"

    client_roles[sid] = {"role": role, "player_idx": None}

    emit("init", {
        "role": role,
        "state": game_state,
        "player_claims": public_claims(),
    })

    print(f"[connect]  {sid[:8]}… → {role}  (total: {len(client_roles)})")


@socketio.on("disconnect")
def on_disconnect():
    global admin_sid
    sid = request.sid

    if sid == admin_sid:
        admin_sid = None
        print("[disconnect] Admin left — slot is now free for the next visitor.")

    # Release any faction this client had claimed
    for faction, info in list(player_claims.items()):
        if info.get("sid") == sid:
            del player_claims[faction]
            socketio.emit("playerUpdate", {"faction": faction, "claimed": False})
            print(f'[disconnect] Released faction "{faction}"')
            break

    client_roles.pop(sid, None)
    print(f"[disconnect] {sid[:8]}…  (total: {len(client_roles)})")


@socketio.on("saveItem")
def on_save_item(data):
    key = str(data.get("key", ""))
    value = data.get("value")
    game_state[key] = value
    # Broadcast to every other connected client
    emit("stateUpdate", {"key": key, "value": value}, broadcast=True, include_self=False)


@socketio.on("claimPlayer")
def on_claim_player(data):
    sid = request.sid
    faction = str(data.get("faction", ""))
    player_idx = int(data.get("player_idx", -1))

    # Reject if already claimed by a different client
    if faction in player_claims and player_claims[faction].get("sid") != sid:
        emit("claimResult", {"success": False, "message": "That faction is already taken."})
        return

    # Release any previous claim by this client (swap faction case)
    for f, info in list(player_claims.items()):
        if info.get("sid") == sid and f != faction:
            del player_claims[f]
            socketio.emit("playerUpdate", {"faction": f, "claimed": False})

    player_claims[faction] = {"sid": sid, "player_idx": player_idx}
    client_roles[sid]["player_idx"] = player_idx

    emit("claimResult", {"success": True, "faction": faction, "player_idx": player_idx})
    emit(
        "playerUpdate",
        {"faction": faction, "claimed": True, "player_idx": player_idx},
        broadcast=True,
        include_self=False,
    )
    print(f'[claimPlayer] {sid[:8]}… claimed "{faction}" (player index {player_idx})')


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    ensure_socketio_js()

    local_ip = get_local_ip()
    port = 5000

    print()
    print("=" * 58)
    print("  EXTRACOMPUTER  —  Twilight Imperium IV  —  LAN Server")
    print("=" * 58)
    print(f"  Local network:  http://{local_ip}:{port}")
    print(f"  Localhost:      http://127.0.0.1:{port}")
    print()
    print("  Share the LOCAL NETWORK URL with the other players.")
    print("  The FIRST device to load the page becomes the Admin.")
    print("=" * 58)
    print()

    socketio.run(app, host="0.0.0.0", port=port, debug=False)
