import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, TextInput, Alert, Vibration, ScrollView } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const vibColors = {
  background: '#0b1b2b',
  primary: '#00a8e8',
  accent: '#7c3aed',
  card: '#0f2a44',
  text: '#e6f0ff'
};

const ROOM_NAMES = ['A','B','C','D'];
const MAX_PER_ROOM = 10;
const SESSION_SECONDS = 15 * 60;
const SESSION_COUNT = 4;
const STATE_TABLE = 'game_state';
const STATE_ROW_ID = 1;

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const buildRooms = () => ROOM_NAMES.map(id => ({ id, slots: Array(MAX_PER_ROOM).fill(null) }));
const buildSession = () => ({ rooms: buildRooms(), leaderboard: {}, registrationOpen: true, started: false });
const buildTopics = () => ROOM_NAMES.reduce((acc, id) => ({ ...acc, [id]: '' }), {});

export default function App(){
  const [page, setPage] = useState('lobby');
  const [sessions, setSessions] = useState(() => Array.from({ length: SESSION_COUNT }, buildSession));
  const [userName, setUserName] = useState('Guest');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [timerRunning, setTimerRunning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(SESSION_SECONDS);
  const timerRef = useRef(null);
  const [adminMode, setAdminMode] = useState(false);
  const [activeSession, setActiveSession] = useState(0);
  const [viewSession, setViewSession] = useState(0);
  const [roomTopics, setRoomTopics] = useState(buildTopics);
  const [registrationOpensAt, setRegistrationOpensAt] = useState(() => Array(SESSION_COUNT).fill(null));
  const [openDelayMinutes, setOpenDelayMinutes] = useState('5');
  const [lastRoll, setLastRoll] = useState('');
  const [syncStatus, setSyncStatus] = useState(supabase ? 'connecting' : 'local');
  const sessionsRef = useRef(sessions);
  const saveTimerRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const remotePayloadRef = useRef(null);
  const lastRemoteAtRef = useRef(0);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  function buildPayload(updatedAtOverride) {
    return {
      sessions,
      activeSession,
      roomTopics,
      registrationOpensAt,
      updatedAt: updatedAtOverride ?? Date.now()
    };
  }

  function persistState(payload, skipRemote) {
    AsyncStorage.setItem('@rar_state', JSON.stringify(payload));
    if (supabase && !skipRemote) {
      scheduleRemoteSave(payload);
    }
  }

  function scheduleRemoteSave(payload) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveRemoteState(payload);
    }, 500);
  }

  async function saveRemoteState(payload) {
    if (!supabase) return;
    try {
      setSyncStatus('syncing');
      await supabase.from(STATE_TABLE).upsert({
        id: STATE_ROW_ID,
        state: payload,
        updated_at: new Date().toISOString()
      });
      setSyncStatus('synced');
    } catch (error) {
      setSyncStatus('error');
    }
  }

  function applyRemoteState(payload) {
    if (!payload || !payload.updatedAt) return;
    if (payload.updatedAt <= lastRemoteAtRef.current) return;
    lastRemoteAtRef.current = payload.updatedAt;
    applyingRemoteRef.current = true;
    remotePayloadRef.current = payload;
    setSessions(payload.sessions || sessions);
    if (typeof payload.activeSession === 'number') {
      setActiveSession(payload.activeSession);
      setViewSession(payload.activeSession);
    }
    if (payload.roomTopics) setRoomTopics({ ...buildTopics(), ...payload.roomTopics });
    if (Array.isArray(payload.registrationOpensAt)) setRegistrationOpensAt(payload.registrationOpensAt);
  }

  useEffect(() => {
    (async () => {
      const stored = await AsyncStorage.getItem('@rar_state');
      if (stored) {
        const obj = JSON.parse(stored);
        if (Array.isArray(obj.sessions) && obj.sessions.length === SESSION_COUNT) {
          setSessions(obj.sessions);
        }
        if (typeof obj.activeSession === 'number') {
          setActiveSession(obj.activeSession);
          setViewSession(obj.activeSession);
        }
        if (obj.roomTopics) {
          setRoomTopics({ ...buildTopics(), ...obj.roomTopics });
        }
        if (Array.isArray(obj.registrationOpensAt)) {
          setRegistrationOpensAt(obj.registrationOpensAt);
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (applyingRemoteRef.current && remotePayloadRef.current) {
      persistState(remotePayloadRef.current, true);
      applyingRemoteRef.current = false;
      remotePayloadRef.current = null;
      return;
    }
    persistState(buildPayload(), false);
  }, [sessions, activeSession, roomTopics, registrationOpensAt]);

  useEffect(() => {
    if (!supabase) {
      setSyncStatus('local');
      return;
    }
    let active = true;
    async function initSync() {
      try {
        const { data, error } = await supabase
          .from(STATE_TABLE)
          .select('state')
          .eq('id', STATE_ROW_ID)
          .single();
        if (error && error.code !== 'PGRST116') throw error;
        if (data && data.state) {
          applyRemoteState(data.state);
        } else {
          await saveRemoteState(buildPayload());
        }
      } catch (err) {
        if (active) setSyncStatus('error');
      }
    }
    initSync();

    const channel = supabase
      .channel('game-state')
      .on('postgres_changes', { event: '*', schema: 'public', table: STATE_TABLE, filter: `id=eq.${STATE_ROW_ID}` }, payload => {
        if (payload?.new?.state) {
          applyRemoteState(payload.new.state);
          if (active) setSyncStatus('synced');
        }
      })
      .subscribe(status => {
        if (active) setSyncStatus(status === 'SUBSCRIBED' ? 'synced' : 'connecting');
      });

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (timerRunning) {
      timerRef.current = setInterval(() => {
        setSecondsLeft(s => {
          if (s <= 1) {
            clearInterval(timerRef.current);
            setTimerRunning(false);
            handleReveal();
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [timerRunning]);

  useEffect(() => {
    setTimerRunning(false);
    setSecondsLeft(SESSION_SECONDS);
  }, [activeSession]);

  useEffect(() => {
    if (sessions[activeSession].started) {
      setPage('session');
      if (!timerRunning && secondsLeft === SESSION_SECONDS) {
        setTimerRunning(true);
      }
    }
  }, [sessions, activeSession, timerRunning, secondsLeft]);

  useEffect(() => {
    const id = setInterval(() => {
      setRegistrationOpensAt(prev => {
        const now = Date.now();
        let next = prev;
        let updatedSessions = null;
        prev.forEach((ts, idx) => {
          if (ts && ts <= now) {
            if (next === prev) next = [...prev];
            next[idx] = null;
            if (!updatedSessions) updatedSessions = [...sessionsRef.current];
            updatedSessions[idx] = { ...updatedSessions[idx], registrationOpen: true };
          }
        });
        if (updatedSessions) {
          setSessions(updatedSessions);
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  function updateSession(index, updater) {
    setSessions(prev => prev.map((s, i) => (i === index ? updater(s) : s)));
  }

  function formatTime(s) {
    const mm = Math.floor(s / 60).toString().padStart(2, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }

  function formatCountdown(ts) {
    if (!ts) return '';
    const seconds = Math.max(0, Math.ceil((ts - Date.now()) / 1000));
    return formatTime(seconds);
  }

  function isSessionFull(session) {
    return session.rooms.every(r => r.slots.every(s => s));
  }

  function findUserRoom(session, name) {
    for (const room of session.rooms) {
      if (room.slots.includes(name)) return room.id;
    }
    return null;
  }

  function joinRoom(sessionIndex, roomId) {
    if (sessionIndex !== activeSession) {
      Alert.alert('Registration locked', `Registration is open for Session ${activeSession + 1}.`);
      return;
    }
    const session = sessions[sessionIndex];
    if (!session.registrationOpen) {
      Alert.alert('Registration closed');
      return;
    }
    const name = userName.trim() || 'Guest';
    const existing = findUserRoom(session, name);
    if (existing) {
      Alert.alert('Already registered', `You are already in Room ${existing}.`);
      return;
    }
    updateSession(sessionIndex, s => {
      const rooms = s.rooms.map(r => {
        if (r.id !== roomId) return r;
        const emptyIndex = r.slots.indexOf(null);
        if (emptyIndex === -1) return r;
        const slots = [...r.slots];
        slots[emptyIndex] = name;
        return { ...r, slots };
      });
      const next = { ...s, rooms };
      if (isSessionFull(next)) {
        next.registrationOpen = false;
        next.started = true;
      }
      return next;
    });
    setCurrentRoom({ sessionIndex, roomId });
  }

  function leaveRoom(sessionIndex, roomId) {
    const name = userName.trim() || 'Guest';
    updateSession(sessionIndex, s => {
      const rooms = s.rooms.map(r => {
        if (r.id !== roomId) return r;
        const slots = r.slots.map(slot => (slot === name ? null : slot));
        return { ...r, slots };
      });
      return { ...s, rooms };
    });
    if (currentRoom && currentRoom.sessionIndex === sessionIndex && currentRoom.roomId === roomId) {
      setCurrentRoom(null);
    }
  }

  function unregisterSlot(sessionIndex, roomId, index) {
    updateSession(sessionIndex, s => {
      const rooms = s.rooms.map(r => {
        if (r.id !== roomId) return r;
        const slots = [...r.slots];
        const removed = slots[index];
        slots[index] = null;
        if (removed && currentRoom && currentRoom.sessionIndex === sessionIndex && currentRoom.roomId === roomId) {
          const name = userName.trim() || 'Guest';
          if (removed === name) setCurrentRoom(null);
        }
        return { ...r, slots };
      });
      return { ...s, rooms };
    });
  }

  function awardPoint(sessionIndex, name, pts = 1) {
    if (!name) return;
    updateSession(sessionIndex, s => ({
      ...s,
      leaderboard: { ...s.leaderboard, [name]: (s.leaderboard[name] || 0) + pts }
    }));
  }

  function rollDice() {
    if (!currentRoom || currentRoom.sessionIndex !== activeSession) {
      Alert.alert('Join the active session to roll');
      return;
    }
    if (!sessions[activeSession].started) {
      Alert.alert('Session not started', 'Wait for the session to start before rolling.');
      return;
    }
    const roll = Math.floor(Math.random() * 6) + 1;
    let message = `You rolled a ${roll}!`;
    if (roll === 1) {
      message += '\nCLAIM: Pick a wrapped gift from the pile!';
      awardPoint(activeSession, userName.trim() || 'Guest', 1);
    } else if (roll === 6) {
      message += '\nSTEAL: Take a gift from a peer!';
      awardPoint(activeSession, userName.trim() || 'Guest', 2);
    } else {
      message += '\nNo gift action. Keep the vibe!';
    }
    setLastRoll(message);
    Alert.alert('Roll', message);
  }

  function startSession() {
    updateSession(activeSession, s => ({ ...s, started: true, registrationOpen: false }));
    setSecondsLeft(SESSION_SECONDS);
    setTimerRunning(true);
  }

  function handleReveal() {
    Vibration.vibrate(1000);
    Alert.alert('Reveal!', 'Time is up - everyone unwraps now!');
  }

  function resetSession(sessionIndex) {
    updateSession(sessionIndex, () => buildSession());
    if (currentRoom && currentRoom.sessionIndex === sessionIndex) {
      setCurrentRoom(null);
    }
  }

  function scheduleRegistrationOpen() {
    const minutes = parseInt(openDelayMinutes, 10);
    if (!minutes || minutes <= 0) {
      Alert.alert('Enter a valid number of minutes');
      return;
    }
    setRegistrationOpensAt(prev => {
      const next = [...prev];
      next[activeSession] = Date.now() + minutes * 60 * 1000;
      return next;
    });
    updateSession(activeSession, s => ({ ...s, registrationOpen: false }));
  }

  const session = sessions[viewSession];
  const active = sessions[activeSession];
  const openCountdown = formatCountdown(registrationOpensAt[activeSession]);
  const currentRoomLabel = currentRoom ? `S${currentRoom.sessionIndex + 1} / Room ${currentRoom.roomId}` : 'None';

  function renderLobby() {
    return (
      <View>
        <View style={[styles.heroCard, { backgroundColor: vibColors.card }]}> 
          <Text style={styles.heroTitle}>Lobby</Text>
          <Text style={styles.heroSubtitle}>Register for a room and track the leaderboard.</Text>
          <View style={styles.heroStats}>
            <View style={styles.heroStatItem}>
              <Text style={styles.heroStatLabel}>Active Session</Text>
              <Text style={styles.heroStatValue}>S{activeSession + 1}</Text>
            </View>
            <View style={styles.heroStatItem}>
              <Text style={styles.heroStatLabel}>Your Room</Text>
              <Text style={styles.heroStatValue}>{currentRoomLabel}</Text>
            </View>
            <View style={styles.heroStatItem}>
              <Text style={styles.heroStatLabel}>Status</Text>
              <Text style={styles.heroStatValue}>{sessions[activeSession].started ? 'Started' : 'Open'}</Text>
            </View>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Register</Text>
        {renderJoin()}

        <Text style={styles.sectionTitle}>Leaderboard</Text>
        {renderLeaderboard()}
      </View>
    );
  }

  function renderJoin() {
    return (
      <View>
        <Text style={styles.sectionTitle}>Choose Session</Text>
        <View style={styles.sessionRow}>
          {Array.from({ length: SESSION_COUNT }).map((_, idx) => (
            <TouchableOpacity key={idx} onPress={() => setViewSession(idx)}
              style={[styles.sessionButton, viewSession === idx && styles.sessionButtonActive]}>
              <Text style={styles.sessionButtonText}>S{idx + 1}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.infoText}>Registration: {session.registrationOpen ? 'Open' : 'Closed'} {viewSession === activeSession ? '(active session)' : ''}</Text>

        <View style={styles.roomsGrid}>
          {session.rooms.map(room => {
            const filled = room.slots.filter(Boolean).length;
            const open = MAX_PER_ROOM - filled;
            const joinDisabled = !session.registrationOpen || viewSession !== activeSession || session.started;
            return (
              <View key={room.id} style={[styles.roomTile, { backgroundColor: vibColors.card }]}> 
                <Text style={styles.roomTitle}>Room {room.id}</Text>
                <Text style={styles.roomTopic}>Topic: {roomTopics[room.id] || '(set in admin)'}</Text>
                <Text style={styles.roomMeta}>{filled}/{MAX_PER_ROOM} filled · {open} open</Text>
                <TouchableOpacity
                  style={[styles.primaryButton, joinDisabled && styles.primaryButtonDisabled]}
                  onPress={() => joinRoom(viewSession, room.id)}
                  disabled={joinDisabled}
                >
                  <Text style={styles.primaryButtonText}>Join Room</Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      </View>
    );
  }

  function renderSession() {
    const sessionStarted = sessions[activeSession].started;
    return (
      <View>
        <Text style={styles.sectionTitle}>Active Session</Text>
        <View style={[styles.card, { backgroundColor: vibColors.card }]}> 
          <Text style={styles.bigText}>Timer: {sessionStarted ? formatTime(secondsLeft) : 'Not started'}</Text>
          <Text style={styles.infoText}>Active session: S{activeSession + 1}</Text>
          <Text style={styles.infoText}>Your room: {currentRoomLabel}</Text>
          <View style={styles.row}> 
            <TouchableOpacity
              style={[styles.bigButton, { backgroundColor: sessionStarted ? vibColors.accent : '#3a3a3a' }]}
              onPress={rollDice}
              disabled={!sessionStarted}
            >
              <Text style={styles.bigButtonText}>ROLL</Text>
            </TouchableOpacity>
          </View>
          {lastRoll ? <Text style={styles.rollResult}>{lastRoll}</Text> : null}
        </View>
      </View>
    );
  }

  function renderLeaderboard() {
    return (
      <View>
        <Text style={styles.sectionTitle}>Leaderboard</Text>
        <View style={styles.sessionRow}>
          {Array.from({ length: SESSION_COUNT }).map((_, idx) => (
            <TouchableOpacity key={idx} onPress={() => setViewSession(idx)}
              style={[styles.sessionButton, viewSession === idx && styles.sessionButtonActive]}>
              <Text style={styles.sessionButtonText}>S{idx + 1}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={[styles.card, { backgroundColor: vibColors.card }]}> 
          {Object.keys(session.leaderboard).length === 0 ? (
            <Text style={styles.slotText}>No scores yet.</Text>
          ) : (
            Object.entries(session.leaderboard)
              .sort((a, b) => b[1] - a[1])
              .map(([name, pts]) => (
                <View key={name} style={styles.lbRow}>
                  <Text style={styles.slotText}>{name}</Text>
                  <Text style={styles.slotText}>{pts}</Text>
                </View>
              ))
          )}
        </View>
      </View>
    );
  }

  function renderAdmin() {
    if (!adminMode) {
      return (
        <View style={[styles.card, { backgroundColor: vibColors.card }]}> 
          <Text style={styles.infoText}>Enable Admin mode to access controls.</Text>
        </View>
      );
    }
    return (
      <View style={[styles.card, { backgroundColor: '#1b1f3b' }]}> 
        <Text style={styles.sectionTitle}>Admin Controls</Text>
        <Text style={styles.subTitle}>Set Active Session</Text>
        <View style={styles.sessionRow}>
          {Array.from({ length: SESSION_COUNT }).map((_, idx) => (
            <TouchableOpacity key={idx} onPress={() => setActiveSession(idx)}
              style={[styles.sessionButton, activeSession === idx && styles.sessionButtonActive]}>
              <Text style={styles.sessionButtonText}>S{idx + 1}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.adminButton} onPress={startSession}>
          <Text style={styles.adminButtonText}>Start Session Now</Text>
        </TouchableOpacity>

        <Text style={styles.subTitle}>Room Topics</Text>
        {ROOM_NAMES.map(id => (
          <View key={id} style={styles.topicRow}>
            <Text style={styles.topicLabel}>Room {id}</Text>
            <TextInput
              placeholder="Add hot topic"
              placeholderTextColor="#999"
              style={styles.topicInput}
              value={roomTopics[id]}
              onChangeText={text => setRoomTopics(prev => ({ ...prev, [id]: text }))}
            />
          </View>
        ))}

        <Text style={styles.subTitle}>Registration</Text>
        <View style={styles.row}> 
          <TouchableOpacity style={styles.adminButton} onPress={() => updateSession(activeSession, s => ({ ...s, registrationOpen: !s.registrationOpen }))}>
            <Text style={styles.adminButtonText}>{active.registrationOpen ? 'Close Registration' : 'Open Registration'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.adminButton} onPress={() => resetSession(activeSession)}>
            <Text style={styles.adminButtonText}>Reset Session</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.scheduleRow}>
          <TextInput
            placeholder="Minutes"
            placeholderTextColor="#999"
            style={styles.minutesInput}
            value={openDelayMinutes}
            onChangeText={setOpenDelayMinutes}
            keyboardType="numeric"
          />
          <TouchableOpacity style={styles.adminButton} onPress={scheduleRegistrationOpen}>
            <Text style={styles.adminButtonText}>Schedule Open</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.note}>Scheduling sets the registration start time for the active session.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: vibColors.background }]}>
      <View style={styles.ambientGlow} />
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Roll & Roam</Text>
          <Text style={styles.subtitle}>White Elephant Networking Game</Text>
        </View>
        <View style={styles.headerMeta}>
          <Text style={styles.headerMetaText}>Sessions: 4 x 15 minutes</Text>
          <Text style={styles.headerMetaText}>10 people per room</Text>
          <Text style={styles.headerMetaText}>Sync: {syncStatus}</Text>
        </View>
      </View>

      <View style={styles.navBar}>
        {[
          { key: 'lobby', label: 'Lobby' },
          { key: 'session', label: 'Session' },
          { key: 'admin', label: 'Admin' }
        ].map(item => (
          <TouchableOpacity key={item.key} onPress={() => setPage(item.key)}
            style={[styles.navButton, page === item.key && styles.navButtonActive]}>
            <Text style={styles.navButtonText}>{item.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.inputRow}>
        <TextInput placeholder="Your name" placeholderTextColor="#999" style={styles.input}
          value={userName} onChangeText={setUserName} />
        <TouchableOpacity style={styles.adminToggle} onPress={() => setAdminMode(m => !m)}>
          <Text style={styles.adminToggleText}>{adminMode ? 'Admin' : 'User'}</Text>
        </TouchableOpacity>
      </View>

      {openCountdown ? <Text style={styles.infoText}>Registration opens in {openCountdown}</Text> : null}

      {page === 'lobby' && renderLobby()}
      {page === 'session' && renderSession()}
      {page === 'admin' && renderAdmin()}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  header: { marginBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', letterSpacing: 1.2 },
  subtitle: { color: '#cbd7ff', fontSize: 12, textTransform: 'uppercase', letterSpacing: 2 },
  headerMeta: { alignItems: 'flex-end' },
  headerMetaText: { color: '#9bb2d9', fontSize: 11 },
  ambientGlow: { position: 'absolute', width: 220, height: 220, borderRadius: 110, backgroundColor: 'rgba(0,168,232,0.2)', top: -40, right: -40 },
  navBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  navButton: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 20, backgroundColor: '#101b2a' },
  navButtonActive: { backgroundColor: vibColors.primary },
  navButtonText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  inputRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 8 },
  input: { flex: 1, backgroundColor: '#091827', color: '#fff', padding: 8, borderRadius: 6, marginRight: 8 },
  adminToggle: { padding: 8, backgroundColor: '#222', borderRadius: 6 },
  adminToggleText: { color: '#fff' },
  sectionTitle: { color: '#a8c9ff', fontWeight: '700', marginVertical: 8 },
  subTitle: { color: '#cbd7ff', fontWeight: '700', marginTop: 8, marginBottom: 4 },
  roomsRow: {},
  roomCard: { padding: 8, borderRadius: 8, marginBottom: 12 },
  roomsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  roomTile: { width: '48%', padding: 12, borderRadius: 12, marginBottom: 12 },
  roomMeta: { color: '#cbd7ff', fontSize: 12, marginBottom: 8 },
  roomTitle: { color: '#fff', fontWeight: '700', fontSize: 16 },
  roomTopic: { color: '#cbd7ff', fontSize: 12, marginBottom: 6 },
  slotRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  slotText: { color: '#e6f0ff' },
  smallButton: { backgroundColor: '#123', padding: 6, borderRadius: 6 },
  smallButtonText: { color: '#fff' },
  card: { padding: 12, borderRadius: 8, marginBottom: 12 },
  heroCard: { padding: 16, borderRadius: 16, marginBottom: 16 },
  heroTitle: { color: '#fff', fontSize: 26, fontWeight: '700', letterSpacing: 1 },
  heroSubtitle: { color: '#cbd7ff', fontSize: 12, marginTop: 4, marginBottom: 12 },
  heroStats: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  heroStatItem: { alignItems: 'center', flex: 1 },
  heroStatLabel: { color: '#9bb2d9', fontSize: 11, textTransform: 'uppercase' },
  heroStatValue: { color: '#fff', fontSize: 16, fontWeight: '700' },
  heroActions: { flexDirection: 'row', gap: 12 },
  primaryButton: { flex: 1, backgroundColor: vibColors.primary, padding: 10, borderRadius: 10, alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontWeight: '700' },
  primaryButtonDisabled: { backgroundColor: '#2a3a4a' },
  secondaryButton: { flex: 1, backgroundColor: '#132238', padding: 10, borderRadius: 10, alignItems: 'center' },
  secondaryButtonText: { color: '#cbd7ff', fontWeight: '700' },
  bigText: { color: '#fff', fontSize: 18, marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
  bigButton: { flex: 1, padding: 12, borderRadius: 8, marginHorizontal: 4, alignItems: 'center' },
  bigButtonText: { color: '#fff', fontWeight: '700' },
  rollResult: { color: '#cbd7ff', marginTop: 10, fontSize: 12, lineHeight: 18 },
  lbRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  adminButton: { flex: 1, backgroundColor: '#2b2b6b', padding: 10, margin: 6, borderRadius: 8, alignItems: 'center' },
  adminButtonText: { color: '#fff' },
  note: { color: '#cfd6ff', fontSize: 12, marginTop: 8 },
  sessionBlock: { marginBottom: 12 },
  sessionRow: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  sessionButton: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#0f1e2f' },
  sessionButtonActive: { backgroundColor: vibColors.accent },
  sessionButtonText: { color: '#fff', fontWeight: '700' },
  infoText: { color: '#cbd7ff', fontSize: 12 },
  topicRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 4 },
  topicLabel: { color: '#cbd7ff', width: 70 },
  topicInput: { flex: 1, backgroundColor: '#091827', color: '#fff', padding: 6, borderRadius: 6 },
  scheduleRow: { flexDirection: 'row', alignItems: 'center' },
  minutesInput: { width: 80, backgroundColor: '#091827', color: '#fff', padding: 6, borderRadius: 6, marginRight: 8 }
});
