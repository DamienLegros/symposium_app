import React, { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View, Vibration } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const vibColors = {
  background: '#0b1b2b',
  primary: '#00a8e8',
  accent: '#7c3aed',
  card: '#0f2a44',
  text: '#e6f0ff'
};

const ROOM_NAMES = ['A', 'B', 'C', 'D'];
const MAX_PER_ROOM = 10;
const SESSION_SECONDS = 15 * 60;
const SESSION_COUNT = 4;
const STATE_TABLE = 'game_state';
const STATE_ROW_ID = 1;
const NAMES_TABLE = 'player_names';
const PROFILE_KEY = '@rar_profile';
const ADMIN_MAP = {
  admin1: 'A',
  admin2: 'B',
  admin3: 'C',
  admin4: 'D'
};

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const buildRooms = () => ROOM_NAMES.map(id => ({ id, slots: Array(MAX_PER_ROOM).fill(null) }));
const buildSession = () => ({ rooms: buildRooms(), leaderboard: {}, registrationOpen: true, started: false });
const buildTopics = () => ROOM_NAMES.reduce((acc, id) => ({ ...acc, [id]: '' }), {});

export default function App() {
  const [page, setPage] = useState('register');
  const [sessions, setSessions] = useState(() => Array.from({ length: SESSION_COUNT }, buildSession));
  const [activeSession, setActiveSession] = useState(0);
  const [roomTopics, setRoomTopics] = useState(buildTopics);
  const [registrationOpensAt, setRegistrationOpensAt] = useState(() => Array(SESSION_COUNT).fill(null));
  const [openDelayMinutes, setOpenDelayMinutes] = useState('5');
  const [timerRunning, setTimerRunning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(SESSION_SECONDS);
  const [lastRoll, setLastRoll] = useState('');
  const [syncStatus, setSyncStatus] = useState(supabase ? 'connecting' : 'local');
  const [nameInput, setNameInput] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [currentRoom, setCurrentRoom] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminRoom, setAdminRoom] = useState(null);
  const [nameError, setNameError] = useState('');

  const timerRef = useRef(null);
  const sessionsRef = useRef(sessions);
  const saveTimerRef = useRef(null);
  const applyingRemoteRef = useRef(false);
  const remotePayloadRef = useRef(null);
  const lastRemoteAtRef = useRef(0);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    (async () => {
      const storedProfile = await AsyncStorage.getItem(PROFILE_KEY);
      if (storedProfile) {
        const profile = JSON.parse(storedProfile);
        if (profile?.name) {
          setPlayerName(profile.name);
          const lower = profile.name.toLowerCase();
          const room = ADMIN_MAP[lower] || null;
          setIsAdmin(Boolean(room));
          setAdminRoom(room);
          setPage('lobby');
        }
      }

      const stored = await AsyncStorage.getItem('@rar_state');
      if (stored) {
        const obj = JSON.parse(stored);
        if (Array.isArray(obj.sessions) && obj.sessions.length === SESSION_COUNT) {
          setSessions(obj.sessions);
        }
        if (typeof obj.activeSession === 'number') {
          setActiveSession(obj.activeSession);
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
    }
    if (payload.roomTopics) setRoomTopics({ ...buildTopics(), ...payload.roomTopics });
    if (Array.isArray(payload.registrationOpensAt)) setRegistrationOpensAt(payload.registrationOpensAt);
  }

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
    if (!currentRoom) return;
    if (sessions[activeSession].started) {
      setPage('session');
      if (!timerRunning && secondsLeft === SESSION_SECONDS) {
        setTimerRunning(true);
      }
    }
  }, [sessions, activeSession, currentRoom, timerRunning, secondsLeft]);

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

  async function claimName() {
    const name = nameInput.trim();
    if (!name) {
      setNameError('Enter a name.');
      return;
    }
    if (name.length < 2 || name.length > 20) {
      setNameError('Name must be 2-20 characters.');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      setNameError('Use letters, numbers, - or _.');
      return;
    }
    setNameError('');

    if (supabase) {
      const { error } = await supabase.from(NAMES_TABLE).insert({ name });
      if (error) {
        if (error.code === '23505' || String(error.message || '').toLowerCase().includes('duplicate')) {
          setNameError('Name already taken.');
          return;
        }
        setNameError('Name unavailable. Try again.');
        return;
      }
    }

    await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify({ name }));
    setPlayerName(name);
    const lower = name.toLowerCase();
    const room = ADMIN_MAP[lower] || null;
    setIsAdmin(Boolean(room));
    setAdminRoom(room);
    setPage('lobby');
  }

  async function clearProfile() {
    const name = playerName;
    if (name) {
      setSessions(prev => prev.map(session => ({
        ...session,
        rooms: session.rooms.map(room => ({
          ...room,
          slots: room.slots.map(slot => (slot === name ? null : slot))
        }))
      })));
      if (supabase) {
        await supabase.from(NAMES_TABLE).delete().eq('name', name);
      }
    }
    await AsyncStorage.removeItem(PROFILE_KEY);
    setPlayerName('');
    setIsAdmin(false);
    setAdminRoom(null);
    setCurrentRoom(null);
    setLastRoll('');
    setNameInput('');
    setPage('register');
  }

  function updateSession(index, updater) {
    setSessions(prev => prev.map((s, i) => (i === index ? updater(s) : s)));
  }

  function isSessionFull(session) {
    return session.rooms.every(r => r.slots.every(s => s));
  }

  function joinRoom(roomId) {
    if (!playerName) {
      Alert.alert('Register first', 'Please register a name before joining a room.');
      setPage('register');
      return;
    }
    const session = sessions[activeSession];
    if (!session.registrationOpen || session.started) {
      Alert.alert('Registration closed');
      return;
    }
    const name = playerName || 'Guest';
    for (const room of session.rooms) {
      if (room.slots.includes(name)) {
        Alert.alert('Already registered', 'You are already in a room.');
        return;
      }
    }
    updateSession(activeSession, s => {
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
    setCurrentRoom({ sessionIndex: activeSession, roomId });
    setPage('waiting');
  }

  function rollDice() {
    if (!sessions[activeSession].started) {
      Alert.alert('Session not started', 'Wait for the session to start before rolling.');
      return;
    }
    const roll = Math.floor(Math.random() * 6) + 1;
    const message = `You rolled a ${roll}!`;
    setLastRoll(message);
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

  function resetSession() {
    updateSession(activeSession, () => buildSession());
    setCurrentRoom(null);
    setLastRoll('');
    setPage('lobby');
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

  function formatTime(s) {
    const mm = Math.floor(s / 60).toString().padStart(2, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  }

  const session = sessions[activeSession];
  const currentRoomLabel = currentRoom ? `Room ${currentRoom.roomId}` : 'None';
  const openCountdown = registrationOpensAt[activeSession] ? formatTime(Math.max(0, Math.ceil((registrationOpensAt[activeSession] - Date.now()) / 1000))) : '';

  function renderRegister() {
    return (
      <View style={styles.card}>
        <Text style={styles.pageTitle}>Register</Text>
        <Text style={styles.pageSubtitle}>Claim a name to enter the game.</Text>
        <TextInput
          placeholder="Your name"
          placeholderTextColor="#999"
          style={styles.input}
          value={nameInput}
          onChangeText={setNameInput}
        />
        {nameError ? <Text style={styles.errorText}>{nameError}</Text> : null}
        <TouchableOpacity style={styles.primaryButton} onPress={claimName}>
          <Text style={styles.primaryButtonText}>Continue</Text>
        </TouchableOpacity>
        <Text style={styles.helperText}>Use admin1/admin2/admin3/admin4 to access room admin controls.</Text>
      </View>
    );
  }

  function renderLobby() {
    return (
      <View>
        <View style={styles.card}>
          <Text style={styles.pageTitle}>Lobby</Text>
          <Text style={styles.pageSubtitle}>Leaderboard and room registration.</Text>
          <Text style={styles.infoText}>Active session: S{activeSession + 1} ({session.registrationOpen ? 'open' : 'closed'})</Text>
          {openCountdown ? <Text style={styles.infoText}>Registration opens in {openCountdown}</Text> : null}
          <Text style={styles.infoText}>Your name: {playerName || 'Guest'}</Text>
        </View>

        <View style={styles.sectionBlock}>
          <Text style={styles.sectionTitle}>Leaderboard</Text>
          <View style={styles.card}>
            {Object.keys(session.leaderboard).length === 0 ? (
              <Text style={styles.infoText}>No scores yet.</Text>
            ) : (
              Object.entries(session.leaderboard)
                .sort((a, b) => b[1] - a[1])
                .map(([name, pts]) => (
                  <View key={name} style={styles.rowBetween}>
                    <Text style={styles.infoText}>{name}</Text>
                    <Text style={styles.infoText}>{pts}</Text>
                  </View>
                ))
            )}
          </View>
        </View>

        <View style={styles.sectionBlock}>
          <Text style={styles.sectionTitle}>Rooms</Text>
          <View style={styles.roomsGrid}>
            {session.rooms.map(room => {
              const filled = room.slots.filter(Boolean).length;
              const open = MAX_PER_ROOM - filled;
              const joinDisabled = !session.registrationOpen || session.started;
              return (
                <View key={room.id} style={[styles.roomTile, styles.card]}>
                  <Text style={styles.roomTitle}>Room {room.id}</Text>
                  <Text style={styles.infoText}>Topic: {roomTopics[room.id] || '(set by admin)'}</Text>
                  <Text style={styles.infoText}>{filled}/{MAX_PER_ROOM} filled · {open} open</Text>
                  <TouchableOpacity
                    style={[styles.primaryButton, joinDisabled && styles.primaryButtonDisabled]}
                    onPress={() => joinRoom(room.id)}
                    disabled={joinDisabled}
                  >
                    <Text style={styles.primaryButtonText}>Join Room</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        </View>
      </View>
    );
  }

  function renderWaiting() {
    const filled = currentRoom ? session.rooms.find(r => r.id === currentRoom.roomId)?.slots.filter(Boolean).length || 0 : 0;
    return (
      <View style={styles.card}>
        <Text style={styles.pageTitle}>Waiting Room</Text>
        <Text style={styles.pageSubtitle}>Hold tight until the room is full or the admin starts.</Text>
        <Text style={styles.infoText}>Your room: {currentRoomLabel}</Text>
        <Text style={styles.infoText}>Filled: {filled}/{MAX_PER_ROOM}</Text>
        <Text style={styles.infoText}>Status: {session.started ? 'Started' : 'Waiting'}</Text>
      </View>
    );
  }

  function renderSession() {
    return (
      <View style={styles.card}>
        <Text style={styles.pageTitle}>Session Live</Text>
        <Text style={styles.pageSubtitle}>Roll the dice when it is your turn.</Text>
        <Text style={styles.infoText}>Timer: {formatTime(secondsLeft)}</Text>
        <Text style={styles.infoText}>Room: {currentRoomLabel}</Text>
        <TouchableOpacity style={styles.diceButton} onPress={rollDice}>
          <Text style={styles.diceText}>ROLL</Text>
        </TouchableOpacity>
        {lastRoll ? <Text style={styles.rollResult}>{lastRoll}</Text> : null}
      </View>
    );
  }

  function renderAdmin() {
    if (!isAdmin) return null;
    return (
      <View style={styles.card}>
        <Text style={styles.pageTitle}>Admin</Text>
        <View style={styles.rowBetween}>
          <Text style={styles.infoText}>Sync: {syncStatus}</Text>
          <Text style={styles.infoText}>Room {adminRoom || '-'}</Text>
        </View>
        <View style={styles.sessionRow}>
          {Array.from({ length: SESSION_COUNT }).map((_, idx) => (
            <TouchableOpacity key={idx} onPress={() => setActiveSession(idx)} style={[styles.sessionButton, activeSession === idx && styles.sessionButtonActive]}>
              <Text style={styles.sessionButtonText}>S{idx + 1}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity style={styles.primaryButton} onPress={startSession}>
          <Text style={styles.primaryButtonText}>Start Session</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={resetSession}>
          <Text style={styles.secondaryButtonText}>Reset Session</Text>
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>Room Topics</Text>
        {adminRoom ? (
          <View style={styles.topicRow}>
            <Text style={styles.topicLabel}>Room {adminRoom}</Text>
            <TextInput
              placeholder="Hot topic"
              placeholderTextColor="#999"
              style={styles.topicInput}
              value={roomTopics[adminRoom]}
              onChangeText={text => setRoomTopics(prev => ({ ...prev, [adminRoom]: text }))}
            />
          </View>
        ) : null}

        <Text style={styles.sectionTitle}>Registration</Text>
        <View style={styles.rowBetween}>
          <TextInput
            placeholder="Minutes"
            placeholderTextColor="#999"
            style={styles.minutesInput}
            value={openDelayMinutes}
            onChangeText={setOpenDelayMinutes}
            keyboardType="numeric"
          />
          <TouchableOpacity style={styles.primaryButton} onPress={scheduleRegistrationOpen}>
            <Text style={styles.primaryButtonText}>Schedule Open</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: vibColors.background }]}
      contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Roll & Roam</Text>
          <Text style={styles.subtitle}>White Elephant Networking Game</Text>
        </View>
        {playerName ? (
          <View style={styles.headerActions}>
            <Text style={styles.badge}>Hi, {playerName}</Text>
            <TouchableOpacity style={styles.logoutButton} onPress={clearProfile}>
              <Text style={styles.logoutText}>Not me</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {page === 'register' && renderRegister()}
      {page === 'lobby' && renderLobby()}
      {page === 'waiting' && renderWaiting()}
      {page === 'session' && renderSession()}
      {isAdmin && renderAdmin()}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#cbd7ff', fontSize: 12, textTransform: 'uppercase', letterSpacing: 2 },
  badge: { color: '#0b1b2b', backgroundColor: '#cbd7ff', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, fontSize: 12 },
  headerActions: { alignItems: 'flex-end', gap: 6 },
  logoutButton: { backgroundColor: '#132238', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  logoutText: { color: '#cbd7ff', fontSize: 12 },
  card: { backgroundColor: vibColors.card, padding: 16, borderRadius: 16, marginBottom: 16 },
  pageTitle: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 6 },
  pageSubtitle: { color: '#cbd7ff', fontSize: 12, marginBottom: 12 },
  sectionTitle: { color: '#a8c9ff', fontWeight: '700', marginVertical: 8 },
  sectionBlock: { marginBottom: 16 },
  input: { backgroundColor: '#091827', color: '#fff', padding: 10, borderRadius: 8, marginBottom: 10 },
  errorText: { color: '#ff7a7a', marginBottom: 10 },
  helperText: { color: '#9bb2d9', fontSize: 12, marginTop: 6 },
  infoText: { color: '#cbd7ff', fontSize: 12, marginBottom: 6 },
  roomsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  roomTile: { width: '48%' },
  roomTitle: { color: '#fff', fontWeight: '700', marginBottom: 6 },
  primaryButton: { backgroundColor: vibColors.primary, padding: 10, borderRadius: 10, alignItems: 'center', marginTop: 6 },
  primaryButtonText: { color: '#fff', fontWeight: '700' },
  primaryButtonDisabled: { backgroundColor: '#2a3a4a' },
  secondaryButton: { backgroundColor: '#132238', padding: 10, borderRadius: 10, alignItems: 'center', marginTop: 8 },
  secondaryButtonText: { color: '#cbd7ff', fontWeight: '700' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  diceButton: { backgroundColor: vibColors.accent, paddingVertical: 12, borderRadius: 16, alignItems: 'center', marginTop: 10 },
  diceText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  rollResult: { color: '#cbd7ff', marginTop: 10 },
  sessionRow: { flexDirection: 'row', gap: 8, marginVertical: 10 },
  sessionButton: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: '#0f1e2f' },
  sessionButtonActive: { backgroundColor: vibColors.accent },
  sessionButtonText: { color: '#fff', fontWeight: '700' },
  topicRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 6 },
  topicLabel: { color: '#cbd7ff', width: 70 },
  topicInput: { flex: 1, backgroundColor: '#091827', color: '#fff', padding: 6, borderRadius: 6 },
  minutesInput: { width: 90, backgroundColor: '#091827', color: '#fff', padding: 8, borderRadius: 6 }
});
