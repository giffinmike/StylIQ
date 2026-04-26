import React, {useEffect, useState, useRef, useCallback} from 'react';
import {
  View,
  Text,
  ScrollView,
  Image,
  StyleSheet,
  Animated,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Easing,
  Modal,
  TextInput,
  TouchableOpacity,
  Alert,
  PanResponder,
  AppState,
} from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import {useAuth0} from 'react-native-auth0';
import {Calendar, DateData} from 'react-native-calendars';
import DateTimePicker from '@react-native-community/datetimepicker';
import {useAppTheme} from '../context/ThemeContext';
import {useUUID} from '../context/UUIDContext';
import {API_BASE_URL} from '../config/api';
import {getAccessToken} from '../utils/auth';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {moderateScale} from '../utils/scale';
import {useGlobalStyles} from '../styles/useGlobalStyles';
import {tokens} from '../styles/tokens/tokens';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  syncNativeCalendarToBackend,
  saveEventToIOSCalendar,
  deleteEventFromIOSCalendar,
  getAllIOSCalendarEventIds,
} from '../utils/calendarSync';
import * as Animatable from 'react-native-animatable';
import AsyncStorage from '@react-native-async-storage/async-storage';
import LinearGradient from 'react-native-linear-gradient';
import {BlurView} from '@react-native-community/blur';
import {useCalendarEventPromptStore} from '../../../../store/calendarEventPromptStore';
import {globalNavigate} from '../MainApp';
import {removeCalendarEvent} from '../utils/calendar';
import {
  useCalendarEvents,
  useCreateCalendarEvent,
  useDeleteCalendarEvent,
  useScheduledOutfits,
  useDeleteScheduledOutfit,
  useInvalidateCalendarData,
  CalendarEvent,
  NormalizedOutfitItem,
} from '../hooks/useCalendar';
import {getTrips} from '../lib/trips/tripsStorage';
import {getTripDateKeys, reconcileTripCalendarEvents} from '../utils/tripCalendarSync';
import {Trip} from '../types/trips';

// ───────── helpers ─────────
const getLocalDateKey = (iso: string | Date | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const formatLocalTime = (iso?: string) => {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
};

const h = (
  type:
    | 'selection'
    | 'impactLight'
    | 'impactMedium'
    | 'impactHeavy'
    | 'notificationSuccess',
) =>
  ReactNativeHapticFeedback.trigger(type, {
    enableVibrateFallback: true,
    ignoreAndroidSystemSettings: false,
  });

// ───────── Swipe constants ─────────
const DELETE_BUTTON_WIDTH = 88;
const EDGE_GUARD = 24;

// ───────── SwipeableEventCard ─────────
type SwipeableEventCardProps = {
  event: any;
  formatLocalTime: (iso?: string) => string;
  theme: any;
  onDelete: (eventId: string) => void;
};

function SwipeableEventCard({
  event,
  formatLocalTime,
  theme,
  onDelete,
}: SwipeableEventCardProps) {
  const panX = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (e, g) =>
        e.nativeEvent.pageX > EDGE_GUARD && Math.abs(g.dx) > 4,
      onMoveShouldSetPanResponderCapture: (e, g) =>
        e.nativeEvent.pageX > EDGE_GUARD && Math.abs(g.dx) > 4,
      onPanResponderMove: (_e, g) => {
        if (g.dx < 0) {
          panX.setValue(Math.max(g.dx, -DELETE_BUTTON_WIDTH));
        }
      },
      onPanResponderRelease: (_e, g) => {
        const velocityTrigger = g.vx < -0.15;
        const distanceTrigger = g.dx < -50;
        if (velocityTrigger || distanceTrigger) {
          Animated.timing(panX, {
            toValue: -DELETE_BUTTON_WIDTH,
            duration: 180,
            useNativeDriver: true,
          }).start();
        } else {
          Animated.timing(panX, {
            toValue: 0,
            duration: 160,
            useNativeDriver: true,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(panX, {
          toValue: 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  const handleDeletePress = useCallback(() => {
    h('impactMedium');
    onDelete(event.event_id || event.id);
  }, [event, onDelete]);

  const swipeStyles = StyleSheet.create({
    container: {
      position: 'relative',
      overflow: 'hidden',
      borderRadius: 16,
      marginBottom: 6,
    },
    deleteButton: {
      position: 'absolute',
      right: 0,
      top: 0,
      bottom: 0,
      width: DELETE_BUTTON_WIDTH,
      backgroundColor: '#FF3B30',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 16,
    },
    deleteText: {
      color: '#fff',
      fontSize: 17,
      fontWeight: '600',
    },
    card: {
      borderRadius: 16,
      padding: 14,
      backgroundColor: theme.colors.surface3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.surfaceBorder,
      borderLeftWidth: 3,
      borderLeftColor: '#ffdd00ff',
    },
    name: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: '600',
    },
    time: {
      color: theme.colors.foreground2,
      marginTop: 4,
      fontSize: 13,
    },
    notes: {
      fontStyle: 'italic',
      color: theme.colors.foreground2,
      marginTop: 8,
    },
  });

  return (
    <View style={swipeStyles.container}>
      <View style={swipeStyles.deleteButton}>
        <TouchableOpacity
          onPress={handleDeletePress}
          style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
          <Text style={swipeStyles.deleteText}>Delete</Text>
        </TouchableOpacity>
      </View>

      <Animated.View
        {...panResponder.panHandlers}
        style={{transform: [{translateX: panX}]}}>
        <View style={swipeStyles.card}>
          <Text style={swipeStyles.name}>{event.title}</Text>
          <Text style={swipeStyles.time}>
            {formatLocalTime(event.start_date)} →{' '}
            {formatLocalTime(event.end_date)}
          </Text>
          {event.location ? (
            <Text style={swipeStyles.notes}>📍 {event.location}</Text>
          ) : null}
          {event.notes ? (
            <Text style={swipeStyles.notes}>{event.notes}</Text>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

// ───────── SwipeableOutfitCard ─────────
type SwipeableOutfitCardProps = {
  outfit: any;
  formatLocalTime: (iso?: string) => string;
  theme: any;
  onDelete: (outfitId: string) => void;
};

function SwipeableOutfitCard({
  outfit,
  formatLocalTime,
  theme,
  onDelete,
}: SwipeableOutfitCardProps) {
  const panX = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (e, g) =>
        e.nativeEvent.pageX > EDGE_GUARD && Math.abs(g.dx) > 4,
      onMoveShouldSetPanResponderCapture: (e, g) =>
        e.nativeEvent.pageX > EDGE_GUARD && Math.abs(g.dx) > 4,
      onPanResponderMove: (_e, g) => {
        if (g.dx < 0) {
          panX.setValue(Math.max(g.dx, -DELETE_BUTTON_WIDTH));
        }
      },
      onPanResponderRelease: (_e, g) => {
        const velocityTrigger = g.vx < -0.15;
        const distanceTrigger = g.dx < -50;
        if (velocityTrigger || distanceTrigger) {
          Animated.timing(panX, {
            toValue: -DELETE_BUTTON_WIDTH,
            duration: 180,
            useNativeDriver: true,
          }).start();
        } else {
          Animated.timing(panX, {
            toValue: 0,
            duration: 160,
            useNativeDriver: true,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(panX, {
          toValue: 0,
          useNativeDriver: true,
        }).start();
      },
    }),
  ).current;

  const handleDeletePress = useCallback(() => {
    h('impactMedium');
    onDelete(outfit.id);
  }, [outfit, onDelete]);

  const swipeStyles = StyleSheet.create({
    container: {
      position: 'relative',
      overflow: 'hidden',
      borderRadius: 16,
      marginBottom: 6,
    },
    deleteButton: {
      position: 'absolute',
      right: 0,
      top: 0,
      bottom: 0,
      width: DELETE_BUTTON_WIDTH,
      backgroundColor: '#FF3B30',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 16,
    },
    deleteText: {
      color: '#fff',
      fontSize: 17,
      fontWeight: '600',
    },
    card: {
      borderRadius: 16,
      padding: 14,
      backgroundColor: theme.colors.surface3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.surfaceBorder,
      borderLeftWidth: 3,
      borderLeftColor: '#00ff73ff',
    },
    name: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: '600',
    },
    time: {
      color: theme.colors.foreground2,
      marginTop: 4,
      fontSize: 13,
    },
    notes: {
      fontStyle: 'italic',
      color: theme.colors.foreground2,
      marginTop: 8,
    },
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 10,
      gap: 4,
    },
    thumb: {
      width: 68,
      height: 68,
      borderRadius: tokens.borderRadius.switch1,
      backgroundColor: theme.colors.imageBackground,
      padding: 4
    },
  });

  return (
    <View style={swipeStyles.container}>
      <View style={swipeStyles.deleteButton}>
        <TouchableOpacity
          onPress={handleDeletePress}
          style={{flex: 1, justifyContent: 'center', alignItems: 'center'}}>
          <Text style={swipeStyles.deleteText}>Delete</Text>
        </TouchableOpacity>
      </View>

      <Animated.View
        {...panResponder.panHandlers}
        style={{transform: [{translateX: panX}]}}>
        <View style={swipeStyles.card}>
          <Text style={swipeStyles.name}>
            {outfit.name || 'Unnamed Outfit'}
          </Text>
          <Text style={swipeStyles.time}>
            🕒 {formatLocalTime(outfit.plannedDate)}
          </Text>
          <View style={swipeStyles.row}>
            {(outfit.allItems ?? [outfit.top, outfit.bottom, outfit.shoes].filter(Boolean)).map(
              (item: NormalizedOutfitItem | null | undefined) =>
                item?.image && (
                  <Image
                    key={item.id}
                    source={{uri: item.image}}
                    style={swipeStyles.thumb}
                    resizeMode="contain"
                  />
                ),
            )}
          </View>
          {outfit.notes ? (
            <Text style={swipeStyles.notes}>{outfit.notes}</Text>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

// ───────── TripCalendarCard ─────────
type TripCalendarCardProps = {
  trip: Trip;
  theme: any;
};

function TripCalendarCard({trip, theme}: TripCalendarCardProps) {
  const formatDateRange = (start: string, end: string) => {
    const s = new Date(start + 'T00:00:00');
    const e = new Date(end + 'T00:00:00');
    const opts: Intl.DateTimeFormatOptions = {month: 'short', day: 'numeric'};
    return `${s.toLocaleDateString(undefined, opts)} – ${e.toLocaleDateString(undefined, opts)}`;
  };

  const cardStyles = StyleSheet.create({
    card: {
      borderRadius: 16,
      padding: 14,
      backgroundColor: theme.colors.surface3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.surfaceBorder,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.button3,
      marginBottom: 6,
    },
    title: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: '600',
    },
    date: {
      color: theme.colors.foreground2,
      marginTop: 4,
      fontSize: 13,
    },
    activities: {
      color: theme.colors.foreground2,
      marginTop: 6,
      fontSize: 13,
      fontStyle: 'italic',
    },
  });

  return (
    <View style={cardStyles.card}>
      <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
        <MaterialIcons name="flight" size={18} color={theme.colors.button3} />
        <Text style={cardStyles.title}>Trip: {trip.destination}</Text>
      </View>
      <Text style={cardStyles.date}>
        {formatDateRange(trip.startDate, trip.endDate)}
      </Text>
      {trip.activities.length > 0 && (
        <Text style={cardStyles.activities}>
          {trip.activities.join(', ')}
        </Text>
      )}
    </View>
  );
}

// ───────── main ─────────
export default function OutfitPlannerScreen() {
  const {user} = useAuth0();
  const userId = useUUID() || user?.sub || '';
  const {theme} = useAppTheme();
  const globalStyles = useGlobalStyles();
  const insets = useSafeAreaInsets();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const translateAnim = useRef(new Animated.Value(30)).current;

  // ───────── TanStack Query hooks ─────────
  const {data: calendarEvents = [], refetch: refetchCalendarEvents} =
    useCalendarEvents(userId);

  const {data: scheduledOutfits = [], refetch: refetchScheduledOutfits} =
    useScheduledOutfits(userId, API_BASE_URL);

  const createEventMutation = useCreateCalendarEvent();
  const deleteEventMutation = useDeleteCalendarEvent();
  const deleteOutfitMutation = useDeleteScheduledOutfit();
  const invalidateCalendarData = useInvalidateCalendarData();

  const [trips, setTrips] = useState<Trip[]>([]);

  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

  const [aiPromptVisible, setAiPromptVisible] = useState(false);
  const [promptEvent, setPromptEvent] = useState<CalendarEvent | null>(null);
  const [loadingSuggestion, setLoadingSuggestion] = useState(false);
  const [aiOutfit, setAiOutfit] = useState<any>(null);

  // Add Event Modal State
  const [addEventModalVisible, setAddEventModalVisible] = useState(false);
  // Upcoming Modal State
  const [upcomingModalVisible, setUpcomingModalVisible] = useState(false);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventLocation, setNewEventLocation] = useState('');
  const [newEventNotes, setNewEventNotes] = useState('');
  const [newEventStartTime, setNewEventStartTime] = useState<Date>(new Date());
  const [newEventEndTime, setNewEventEndTime] = useState<Date>(new Date());
  const [savingEvent, setSavingEvent] = useState(false);

  // Load persisted event prompt responses on mount
  const {loadFromStorage, hasAnswered, clearResponses} =
    useCalendarEventPromptStore();
  useEffect(() => {
    (async () => {
      // 🧪 TEMPORARY: Uncomment to clear responses for testing
      // await clearResponses();
      await loadFromStorage();
    })();
  }, [loadFromStorage, clearResponses]);

  // ───────── animations ─────────
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
      Animated.timing(translateAnim, {
        toValue: 0,
        duration: 450,
        easing: Easing.out(Easing.exp),
        useNativeDriver: true,
      }),
    ]).start();
  }, []);

  // ───────── sync native iOS calendar, then refetch via TanStack Query ─────────
  const syncCalendarEvents = useCallback(async () => {
    if (!userId) return;

    // Sync native calendar to backend (this detects deletions made in iOS Calendar)
    await syncNativeCalendarToBackend(userId);

    // Refetch via TanStack Query (replaces manual fetch + Zustand)
    refetchCalendarEvents();
  }, [userId, refetchCalendarEvents]);

  // Check for scheduled outfits whose iOS calendar events were deleted
  const syncDeletedOutfitEvents = useCallback(async () => {
    if (!userId) return;

    // console.log('🔄 Starting syncDeletedOutfitEvents...');

    try {
      // Get all current iOS calendar event IDs
      const iosEventIds = await getAllIOSCalendarEventIds();
      // console.log(`📅 iOS calendar has ${iosEventIds.size} events`);

      // Get all AsyncStorage keys for outfit calendar events
      const allKeys = await AsyncStorage.getAllKeys();
      const outfitCalendarKeys = allKeys.filter(k =>
        k.startsWith('outfitCalendar:'),
      );

      // console.log(
      //   `🔍 Found ${outfitCalendarKeys.length} outfit calendar mappings to check`,
      // );

      for (const key of outfitCalendarKeys) {
        const iosEventId = await AsyncStorage.getItem(key);
        // console.log(`  📋 Key: ${key}, iOS Event ID: ${iosEventId}`);

        if (iosEventId) {
          const exists = iosEventIds.has(iosEventId);
          // console.log(
          //   `  🔍 Event ${iosEventId} exists in iOS Calendar: ${exists}`,
          // );

          if (!exists) {
            // This iOS event was deleted - remove the scheduled outfit
            const outfitId = key.replace('outfitCalendar:', '');
            // console.log(
            //   `🗑️ iOS event ${iosEventId} was deleted, removing outfit schedule ${outfitId}`,
            // );

            // Delete from backend
            try {
              const accessToken = await getAccessToken();
              const res = await fetch(`${API_BASE_URL}/scheduled-outfits`, {
                method: 'DELETE',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({user_id: userId, outfit_id: outfitId}),
              });
              const data = await res.json();
              // console.log(`🗑️ Backend delete response:`, data);

              // Remove the AsyncStorage mapping
              await AsyncStorage.removeItem(key);

              // Signal SavedOutfitsScreen to refresh
              await AsyncStorage.setItem(
                'schedulesChanged',
                Date.now().toString(),
              );

              // console.log(
              //   `✅ Removed scheduled outfit ${outfitId} (iOS event deleted)`,
              // );
            } catch (err) {
              console.error(`❌ Failed to remove outfit schedule:`, err);
            }
          }
        }
      }
      // console.log('🔄 syncDeletedOutfitEvents complete');
    } catch (err) {
      console.error('❌ Failed to sync deleted outfit events:', err);
    }
  }, [userId]);

  // Check for app-created events whose iOS calendar events were deleted
  const syncDeletedAppEvents = useCallback(async () => {
    if (!userId) return;

    // console.log('🔄 Starting syncDeletedAppEvents...');

    try {
      // Get all current iOS calendar event IDs
      const iosEventIds = await getAllIOSCalendarEventIds();
      // console.log(`📅 iOS calendar has ${iosEventIds.size} events`);

      // Get all AsyncStorage keys for app-created calendar events
      const allKeys = await AsyncStorage.getAllKeys();
      const eventCalendarKeys = allKeys.filter(k =>
        k.startsWith('eventCalendar:'),
      );

      // console.log(
      //   `🔍 Found ${eventCalendarKeys.length} app event calendar mappings to check`,
      // );

      for (const key of eventCalendarKeys) {
        const iosEventId = await AsyncStorage.getItem(key);
        // console.log(`  📋 Key: ${key}, iOS Event ID: ${iosEventId}`);

        if (iosEventId) {
          const exists = iosEventIds.has(iosEventId);
          // console.log(
          //   `  🔍 Event ${iosEventId} exists in iOS Calendar: ${exists}`,
          // );

          if (!exists) {
            // This iOS event was deleted - remove the app event from backend
            const eventId = key.replace('eventCalendar:', '');
            // console.log(
            //   `🗑️ iOS event ${iosEventId} was deleted, removing app event ${eventId}`,
            // );

            // Delete from backend using apiClient
            try {
              const accessToken = await getAccessToken();
              await fetch(
                `${API_BASE_URL}/calendar/event/${userId}/${eventId}`,
                {
                  method: 'DELETE',
                  headers: {
                    Authorization: `Bearer ${accessToken}`,
                  },
                },
              );
              // Clean up AsyncStorage
              await AsyncStorage.removeItem(key);
            } catch (err) {
              console.error(`❌ Failed to remove app event:`, err);
            }
          }
        }
      }
      // console.log('🔄 syncDeletedAppEvents complete');
    } catch (err) {
      console.error('❌ Failed to sync deleted app events:', err);
    }
  }, [userId]);

  // Initial sync on mount - check for iOS deletions then fetch
  useEffect(() => {
    if (!userId) return;

    const initialSync = async () => {
      // console.log('📅 Initial mount sync starting...');
      // Check for deleted events FIRST (before fetching from backend)
      await syncDeletedOutfitEvents();
      await syncDeletedAppEvents();
      // Now sync and fetch fresh data from backend
      await syncCalendarEvents();
      // TanStack Query auto-fetches scheduled outfits via useScheduledOutfits hook
      // Load trips for purple dots + reconcile iOS calendar events
      const loadedTrips = await getTrips();
      setTrips(loadedTrips);
      reconcileTripCalendarEvents(loadedTrips).catch(err =>
        console.error('[Calendar] trip reconciliation failed:', err),
      );
    };

    initialSync();
  }, [
    userId,
    syncDeletedOutfitEvents,
    syncDeletedAppEvents,
    syncCalendarEvents,
  ]);

  // Re-sync when app returns to foreground (detects iOS Calendar deletions)
  useEffect(() => {
    if (!userId) return;

    const handleAppActive = async () => {
      // console.log('📅 App became active, re-syncing calendar and outfits...');
      // Check for deleted events FIRST (before fetching from backend)
      // This ensures deletions made in iOS Calendar are reflected in the backend
      await syncDeletedOutfitEvents();
      await syncDeletedAppEvents();
      // Now sync and refetch fresh data via TanStack Query
      await syncCalendarEvents();
      // Invalidate queries to force refetch
      invalidateCalendarData(userId);
      // Refresh trips for purple dots + reconcile iOS calendar events
      const loadedTrips = await getTrips();
      setTrips(loadedTrips);
      reconcileTripCalendarEvents(loadedTrips).catch(err =>
        console.error('[Calendar] trip reconciliation failed:', err),
      );
      // console.log('📅 Sync complete');
    };

    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'active') {
        handleAppActive();
      }
    });

    return () => subscription.remove();
  }, [
    userId,
    syncCalendarEvents,
    syncDeletedOutfitEvents,
    syncDeletedAppEvents,
    invalidateCalendarData,
  ]);

  // ───────── mark dots ─────────
  const allMarks: Record<string, any> = {};
  for (const outfit of scheduledOutfits) {
    const date = getLocalDateKey(outfit.plannedDate);
    if (!allMarks[date]) allMarks[date] = {dots: []};
    allMarks[date].dots.push({
      color: outfit.type === 'ai' ? '#405de6' : '#00ff73ff',
    });
  }
  // console.log(
  //   '📅 Calendar events for dots:',
  //   calendarEvents.length,
  //   calendarEvents.map(e => ({
  //     id: e.event_id,
  //     title: e.title,
  //     start: e.start_date,
  //   })),
  // );
  for (const ev of calendarEvents) {
    const date = getLocalDateKey(ev.start_date);
    // console.log(`📅 Event "${ev.title}" -> date key: "${date}"`);
    if (!allMarks[date]) allMarks[date] = {dots: []};
    allMarks[date].dots.push({color: '#ffdd00ff'});
  }
  // Trip dots (purple)
  for (const trip of trips) {
    const dateKeys = getTripDateKeys(trip.startDate, trip.endDate);
    for (const dateKey of dateKeys) {
      if (!allMarks[dateKey]) allMarks[dateKey] = {dots: []};
      allMarks[dateKey].dots.push({
        color: theme.colors.button3,
        key: `trip-${trip.id}`,
      });
    }
  }
  // console.log('📅 All marks:', Object.keys(allMarks));

  // ───────── find upcoming events (for AI prompt) ─────────
  useEffect(() => {
    if (!calendarEvents.length) {
      // console.log('📅 No calendar events loaded yet');
      return;
    }
    // console.log('🔍 Checking calendar events:', calendarEvents);
    const now = new Date();
    const upcoming = calendarEvents.find(ev => {
      const start = new Date(ev.start_date);
      const hoursDiff = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
      const title = ev.title?.toLowerCase() || '';
      const isRelevant =
        /(dinner|party|event|drinks|wedding|meeting|launch)/.test(title);
      const answered = hasAnswered(ev.event_id);
      // console.log(
      //   `  Event: "${ev.title}" | Hours: ${hoursDiff.toFixed(
      //     1,
      //   )} | Relevant: ${isRelevant} | Answered: ${answered}`,
      // );
      // Only show prompt if event is relevant, within 24 hours, and user hasn't answered yet
      return isRelevant && hoursDiff >= 0 && hoursDiff < 24 && !answered;
    });
    if (upcoming) {
      // console.log('✅ Found eligible event:', upcoming.title);
      setPromptEvent(upcoming);
      setAiPromptVisible(true);
      h('impactMedium');
    } else {
      // console.log('❌ No eligible event found');
    }
  }, [calendarEvents, hasAnswered]);

  const handleStyleIt = async () => {
    if (!promptEvent) return;
    try {
      setLoadingSuggestion(true);
      // Record the "yes" response
      if (promptEvent?.event_id) {
        const {recordResponse} = useCalendarEventPromptStore.getState();
        await recordResponse(promptEvent.event_id, 'yes');
      }
      const prompt = `Outfit suggestion for ${promptEvent.title} at ${
        promptEvent.location || 'a venue'
      } starting ${formatLocalTime(promptEvent.start_date)}.`;

      h('notificationSuccess');
      setLoadingSuggestion(false);

      // Close the prompt and navigate to OutfitSuggestionScreen with the event context
      setAiPromptVisible(false);
      setPromptEvent(null);

      // Navigate to OutfitSuggestionScreen with the event as params
      globalNavigate('Outfit', {
        eventTitle: promptEvent.title,
        eventLocation: promptEvent.location,
        eventStartDate: promptEvent.start_date,
        initialPrompt: prompt,
      });
    } catch (err) {
      console.error('❌ AI suggest error:', err);
      setLoadingSuggestion(false);
    }
  };

  // const handleStyleIt = () => {
  //   console.log(
  //     '⚠️ AI service temporarily disabled — skipping /ai/suggest call.',
  //   );
  //   setAiPromptVisible(false); // just close the prompt for now
  // };

  // ───────── render ─────────
  const styles = StyleSheet.create({
    card: {
      borderRadius: 16,
      padding: 14,
      marginBottom: 6,
      backgroundColor: theme.colors.surface3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.surfaceBorder,
    },
    name: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: tokens.fontWeight.semiBold,
    },
    time: {color: theme.colors.foreground2, marginTop: 4, fontSize: 13},
    notes: {fontStyle: 'italic', color: theme.colors.foreground2, marginTop: 8},
    row: {flexDirection: 'row', marginTop: 10},
    thumb: {
      width: 68,
      height: 68,
      borderRadius: 12,
      marginRight: 8,
      backgroundColor: theme.colors.surface,
    },
    promptBox: {
      position: 'absolute',
      bottom: 60,
      left: 20,
      right: 20,
      borderRadius: 16,
      backgroundColor: theme.colors.surface2,
      padding: 16,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 10,
      elevation: 6,
    },
    promptText: {
      color: theme.colors.foreground,
      fontSize: 16,
      fontWeight: '600',
      marginBottom: 12,
      textAlign: 'center',
    },
    btn: {
      borderRadius: 10,
      paddingVertical: 10,
      backgroundColor: theme.colors.button1,
      alignItems: 'center',
    },
    btnText: {color: theme.colors.foreground, fontWeight: '600', fontSize: 15},
  });

  const outfitsByDate = scheduledOutfits.reduce(
    (acc, outfit) => {
      const date = getLocalDateKey(outfit.plannedDate);
      if (!acc[date]) acc[date] = [];
      acc[date].push(outfit);
      return acc;
    },
    {} as Record<string, any[]>,
  );

  const handleDayPress = (day: DateData) => {
    setSelectedDate(day.dateString);
    setModalVisible(true);
    h('selection');
  };

  const handleSaveEvent = async () => {
    if (!newEventTitle.trim()) {
      Alert.alert('Missing Title', 'Please enter an event title.');
      return;
    }
    if (!selectedDate) {
      Alert.alert(
        'No Date Selected',
        'Please select a date on the calendar first.',
      );
      return;
    }

    setSavingEvent(true);
    h('impactMedium');

    try {
      // Parse the selected date and combine with selected times
      const [year, month, day] = selectedDate.split('-').map(Number);
      const startDate = new Date(
        year,
        month - 1,
        day,
        newEventStartTime.getHours(),
        newEventStartTime.getMinutes(),
        0,
      );
      const endDate = new Date(
        year,
        month - 1,
        day,
        newEventEndTime.getHours(),
        newEventEndTime.getMinutes(),
        0,
      );

      // Use TanStack Query mutation
      createEventMutation.mutate(
        {
          userId,
          title: newEventTitle.trim(),
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          location: newEventLocation.trim() || undefined,
          notes: newEventNotes.trim() || undefined,
        },
        {
          onSuccess: async data => {
            if (data.ok && data.event) {
              // Also save to iOS native calendar
              const iosEventId = await saveEventToIOSCalendar({
                title: newEventTitle.trim(),
                startDate: startDate,
                endDate: endDate,
                location: newEventLocation.trim() || undefined,
                notes: newEventNotes.trim() || undefined,
              });

              // Store iOS event ID in AsyncStorage
              if (iosEventId && data.event.event_id) {
                await AsyncStorage.setItem(
                  `eventCalendar:${data.event.event_id}`,
                  iosEventId,
                );
              }

              h('notificationSuccess');
              // Reset form
              setNewEventTitle('');
              setNewEventLocation('');
              setNewEventNotes('');
              setNewEventStartTime(new Date());
              setNewEventEndTime(new Date());
              setAddEventModalVisible(false);
            } else {
              Alert.alert(
                'Error',
                data.error || 'Failed to create event. Please try again.',
              );
            }
            setSavingEvent(false);
          },
          onError: () => {
            Alert.alert('Error', 'Failed to create event. Please try again.');
            setSavingEvent(false);
          },
        },
      );
    } catch (err) {
      console.error('Failed to create event:', err);
      Alert.alert('Error', 'Failed to create event. Please try again.');
      setSavingEvent(false);
    }
  };

  const openAddEventModal = () => {
    h('impactLight');
    // If no date is selected, default to today
    if (!selectedDate) {
      const today = new Date();
      const y = today.getFullYear();
      const m = String(today.getMonth() + 1).padStart(2, '0');
      const d = String(today.getDate()).padStart(2, '0');
      setSelectedDate(`${y}-${m}-${d}`);
    }
    // Set default times: start at next full hour, end 1 hour later
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0);
    const endHour = new Date(nextHour);
    endHour.setHours(nextHour.getHours() + 1);
    setNewEventStartTime(nextHour);
    setNewEventEndTime(endHour);
    setAddEventModalVisible(true);
  };

  const handleDeleteEvent = useCallback(
    (eventId: string) => {
      Alert.alert(
        'Delete Event',
        'Are you sure you want to delete this event?',
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              // Use TanStack Query mutation for optimistic delete
              deleteEventMutation.mutate(
                {userId, eventId},
                {
                  onSuccess: async () => {
                    h('notificationSuccess');

                    // Delete from iOS calendar
                    if (eventId.startsWith('styliq_')) {
                      const iosEventId = await AsyncStorage.getItem(
                        `eventCalendar:${eventId}`,
                      );
                      if (iosEventId) {
                        await deleteEventFromIOSCalendar(iosEventId);
                        await AsyncStorage.removeItem(
                          `eventCalendar:${eventId}`,
                        );
                      }
                    } else {
                      await deleteEventFromIOSCalendar(eventId);
                    }
                  },
                  onError: () => {
                    Alert.alert('Error', 'Failed to delete event.');
                  },
                },
              );
            },
          },
        ],
      );
    },
    [userId, deleteEventMutation],
  );

  const handleDeleteOutfit = useCallback(
    (outfitId: string) => {
      Alert.alert(
        'Remove Scheduled Outfit',
        'Are you sure you want to remove this outfit from your calendar?',
        [
          {text: 'Cancel', style: 'cancel'},
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              // Use TanStack Query mutation for optimistic delete
              deleteOutfitMutation.mutate(
                {userId, outfitId},
                {
                  onSuccess: async () => {
                    h('notificationSuccess');

                    // Also remove from iOS calendar if there's a stored event ID
                    const key = `outfitCalendar:${outfitId}`;
                    const iosEventId = await AsyncStorage.getItem(key);
                    if (iosEventId) {
                      await removeCalendarEvent(iosEventId);
                      await AsyncStorage.removeItem(key);
                    }

                    // Signal that schedules have changed so SavedOutfitsScreen can refresh
                    await AsyncStorage.setItem(
                      'schedulesChanged',
                      Date.now().toString(),
                    );
                  },
                  onError: () => {
                    Alert.alert('Error', 'Failed to remove outfit.');
                  },
                },
              );
            },
          },
        ],
      );
    },
    [userId, deleteOutfitMutation],
  );

  return (
    <SafeAreaView style={{flex: 1, backgroundColor: theme.colors.background}}>
      <Animated.View
        style={{
          flex: 1,
          opacity: fadeAnim,
          transform: [{translateY: translateAnim}],
        }}>
        <View
          style={{
            height: Math.max(insets.top + 10, 54), // ✅ min 54px for non-notched devices
            backgroundColor: theme.colors.background,
          }}
        />
        <KeyboardAvoidingView
          style={{flex: 1}}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={insets.top + 40}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}>
            <Text style={[globalStyles.header, {marginBottom: 0}]}>
              StylHelpr Calendar
            </Text>
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
              {/* <TouchableOpacity
                onPress={() => {
                  h('impactLight');
                  globalNavigate('OutfitHistory');
                }}
                style={{
                  padding: 8,
                  borderRadius: 20,
                  backgroundColor: theme.colors.surface,
                }}>
                <MaterialIcons
                  name="history"
                  size={24}
                  color={theme.colors.primary}
                />
              </TouchableOpacity> */}
              <TouchableOpacity
                onPress={() => {
                  h('impactLight');
                  setUpcomingModalVisible(true);
                }}
                style={{
                  padding: 8,
                  borderRadius: 20,
                  backgroundColor: theme.colors.surface,
                }}>
                <MaterialIcons
                  name="event-note"
                  size={24}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={openAddEventModal}
                style={{
                  padding: 8,
                  borderRadius: 20,
                  backgroundColor: theme.colors.surface,
                  marginRight: 16,
                }}>
                <MaterialIcons
                  name="add"
                  size={24}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            </View>
          </View>

          <Animated.View style={{flex: 1}}>
            <Calendar
              onDayPress={handleDayPress}
              markedDates={{
                ...allMarks,
                ...(selectedDate
                  ? {
                      [selectedDate]: {
                        selected: true,
                        selectedColor: theme.colors.primary,
                      },
                    }
                  : {}),
              }}
              markingType="multi-dot"
              theme={{
                calendarBackground: theme.colors.background,
                textSectionTitleColor: theme.colors.foreground2,
                dayTextColor: theme.colors.foreground,
                todayTextColor: theme.colors.primary,
                selectedDayBackgroundColor: theme.colors.foreground,
                selectedDayTextColor: theme.colors.background,
                arrowColor: theme.colors.primary,
                monthTextColor: theme.colors.primary,
                textMonthFontWeight: tokens.fontWeight.bold,
                textDayFontSize: 16,
                textMonthFontSize: 18,
                textDayHeaderFontSize: 14,
                dotColor: theme.colors.primary,
                selectedDotColor: '#fff',
                disabledArrowColor: '#444',
              }}
            />

            {/* Details */}
            {modalVisible && (
              <ScrollView
                showsVerticalScrollIndicator={false}
                style={{
                  flex: 1,
                  paddingHorizontal: moderateScale(tokens.spacing.md1),
                }}
                contentContainerStyle={{paddingBottom: insets.bottom + 8}}>
                {(outfitsByDate[selectedDate!] || []).map((o, index) => (
                  <SwipeableOutfitCard
                    key={o.id || index}
                    outfit={o}
                    formatLocalTime={formatLocalTime}
                    theme={theme}
                    onDelete={handleDeleteOutfit}
                  />
                ))}

                {calendarEvents
                  .filter(e => getLocalDateKey(e.start_date) === selectedDate)
                  .filter(e => !e.title?.startsWith('Trip: '))
                  .map(ev => (
                    <SwipeableEventCard
                      key={ev.event_id || ev.id}
                      event={ev}
                      formatLocalTime={formatLocalTime}
                      theme={theme}
                      onDelete={handleDeleteEvent}
                    />
                  ))}

                {trips
                  .filter(t => {
                    const dateKeys = getTripDateKeys(t.startDate, t.endDate);
                    return dateKeys.includes(selectedDate!);
                  })
                  .map(t => (
                    <TripCalendarCard key={`trip-${t.id}`} trip={t} theme={theme} />
                  ))}
              </ScrollView>
            )}
          </Animated.View>

          {aiPromptVisible && promptEvent && (
            <Animatable.View
              animation="fadeInUp"
              duration={450}
              style={styles.promptBox}>
              {!aiOutfit ? (
                <>
                  <Text style={[styles.promptText, {marginBottom: 6}]}>
                    You’ve got{' '}
                    <Text style={{fontWeight: '700'}}>{promptEvent.title}</Text>{' '}
                    coming up
                  </Text>

                  {/* 📅 Date and Time */}
                  <Text
                    style={[
                      styles.time,
                      {textAlign: 'center', marginBottom: 16},
                    ]}>
                    {new Date(promptEvent.start_date).toLocaleDateString(
                      undefined,
                      {
                        weekday: 'long',
                        month: 'short',
                        day: 'numeric',
                      },
                    )}{' '}
                    • {formatLocalTime(promptEvent.start_date)} →{' '}
                    {formatLocalTime(promptEvent.end_date)}
                  </Text>

                  {/* 📍 Location (if available) */}
                  {promptEvent.location ? (
                    <Text
                      style={[
                        styles.notes,
                        {
                          textAlign: 'center',
                          marginBottom: 10,
                          color: theme.colors.foreground2,
                        },
                      ]}>
                      📍 {promptEvent.location}
                    </Text>
                  ) : null}
                  <AppleTouchFeedback onPress={handleStyleIt}>
                    <View style={styles.btn}>
                      {loadingSuggestion ? (
                        <ActivityIndicator color={theme.colors.foreground} />
                      ) : (
                        <Text style={styles.btnText}>Yes, Style It</Text>
                      )}
                    </View>
                  </AppleTouchFeedback>

                  {/* ❌ Cancel / No button */}
                  <AppleTouchFeedback
                    onPress={async () => {
                      if (promptEvent?.event_id) {
                        const {recordResponse} =
                          useCalendarEventPromptStore.getState();
                        await recordResponse(promptEvent.event_id, 'no');
                      }
                      setAiPromptVisible(false);
                      setPromptEvent(null);
                      h('impactLight');
                    }}>
                    <View
                      style={[
                        styles.btn,
                        {
                          marginTop: 8,
                          backgroundColor: theme.colors.surface3,
                        },
                      ]}>
                      <Text
                        style={[
                          styles.btnText,
                          {color: theme.colors.foreground2, fontWeight: '500'},
                        ]}>
                        No, Not Now
                      </Text>
                    </View>
                  </AppleTouchFeedback>
                </>
              ) : (
                <>
                  <Text style={styles.promptText}>Your Styled Look</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {[aiOutfit?.top, aiOutfit?.bottom, aiOutfit?.shoes].map(
                      (piece: any, idx: number) =>
                        piece?.image && (
                          <Image
                            key={idx}
                            source={{uri: piece.image}}
                            style={[styles.thumb, {width: 90, height: 90}]}
                          />
                        ),
                    )}
                  </ScrollView>
                  <AppleTouchFeedback
                    onPress={() => {
                      setAiPromptVisible(false);
                      setAiOutfit(null);
                    }}>
                    <View
                      style={[
                        styles.btn,
                        {marginTop: 10, backgroundColor: theme.colors.surface3},
                      ]}>
                      <Text
                        style={[
                          styles.btnText,
                          {color: theme.colors.foreground},
                        ]}>
                        Close
                      </Text>
                    </View>
                  </AppleTouchFeedback>
                </>
              )}
            </Animatable.View>
          )}
        </KeyboardAvoidingView>
      </Animated.View>

      {/* Add Event Modal */}
      <Modal
        visible={addEventModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setAddEventModalVisible(false)}>
        <View style={{flex: 1, backgroundColor: theme.colors.background}}>
          <SafeAreaView style={{flex: 1}}>
            <View style={{flex: 1, padding: 20}}>
              {/* Modal Header */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 24,
                }}>
                <TouchableOpacity
                  onPress={() => setAddEventModalVisible(false)}>
                  <Text style={{fontSize: 17, color: theme.colors.primary}}>
                    Cancel
                  </Text>
                </TouchableOpacity>
                <Text
                  style={{
                    fontSize: 17,
                    fontWeight: '600',
                    color: theme.colors.foreground,
                  }}>
                  New Event
                </Text>
                <TouchableOpacity
                  onPress={handleSaveEvent}
                  disabled={savingEvent}>
                  <Text
                    style={{
                      fontSize: 17,
                      fontWeight: '600',
                      color: theme.colors.primary,
                      opacity: savingEvent ? 0.5 : 1,
                    }}>
                    {savingEvent ? 'Saving...' : 'Add'}
                  </Text>
                </TouchableOpacity>
              </View>

              {/* Selected Date Display */}
              {selectedDate && (
                <View
                  style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: 12,
                    padding: 16,
                    marginBottom: 20,
                  }}>
                  <Text
                    style={{
                      fontSize: 14,
                      color: theme.colors.muted,
                      marginBottom: 4,
                    }}>
                    Date
                  </Text>
                  <Text
                    style={{
                      fontSize: 17,
                      color: theme.colors.foreground,
                      fontWeight: '500',
                    }}>
                    {(() => {
                      // Parse date manually to avoid timezone issues
                      const [year, month, day] = selectedDate
                        .split('-')
                        .map(Number);
                      const date = new Date(year, month - 1, day);
                      return date.toLocaleDateString('en-US', {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      });
                    })()}
                  </Text>
                </View>
              )}

              {!selectedDate && (
                <View
                  style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: 12,
                    padding: 16,
                    marginBottom: 20,
                  }}>
                  <Text
                    style={{
                      fontSize: 15,
                      color: theme.colors.muted,
                      textAlign: 'center',
                    }}>
                    Select a date on the calendar first
                  </Text>
                </View>
              )}

              {/* Time Pickers */}
              <View style={{flexDirection: 'row', marginBottom: 20, gap: 12}}>
                {/* Start Time */}
                <View style={{flex: 1}}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color: theme.colors.foreground,
                      marginBottom: 8,
                    }}>
                    Starts
                  </Text>
                  <View
                    style={{
                      backgroundColor: theme.colors.surface,
                      borderRadius: 12,
                      overflow: 'hidden',
                    }}>
                    <DateTimePicker
                      value={newEventStartTime}
                      mode="time"
                      display="default"
                      onChange={(_, date) => {
                        if (date) {
                          setNewEventStartTime(date);
                          // Auto-adjust end time to be 1 hour after start
                          const newEnd = new Date(date);
                          newEnd.setHours(date.getHours() + 1);
                          if (newEnd > newEventEndTime) {
                            setNewEventEndTime(newEnd);
                          }
                        }
                      }}
                      themeVariant="dark"
                      style={{height: 44}}
                    />
                  </View>
                </View>

                {/* End Time */}
                <View style={{flex: 1}}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color: theme.colors.foreground,
                      marginBottom: 8,
                    }}>
                    Ends
                  </Text>
                  <View
                    style={{
                      backgroundColor: theme.colors.surface,
                      borderRadius: 12,
                      overflow: 'hidden',
                    }}>
                    <DateTimePicker
                      value={newEventEndTime}
                      mode="time"
                      display="default"
                      onChange={(_, date) => date && setNewEventEndTime(date)}
                      themeVariant="dark"
                      style={{height: 44}}
                    />
                  </View>
                </View>
              </View>

              {/* Title Input */}
              <View style={{marginBottom: 16}}>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.foreground,
                    marginBottom: 8,
                  }}>
                  Title
                </Text>
                <TextInput
                  placeholder="Event title"
                  placeholderTextColor={theme.colors.muted}
                  value={newEventTitle}
                  onChangeText={setNewEventTitle}
                  style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: 12,
                    padding: 16,
                    fontSize: 16,
                    color: theme.colors.foreground,
                  }}
                />
              </View>

              {/* Location Input */}
              <View style={{marginBottom: 16}}>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.foreground,
                    marginBottom: 8,
                  }}>
                  Location
                </Text>
                <TextInput
                  placeholder="Add location (optional)"
                  placeholderTextColor={theme.colors.muted}
                  value={newEventLocation}
                  onChangeText={setNewEventLocation}
                  style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: 12,
                    padding: 16,
                    fontSize: 16,
                    color: theme.colors.foreground,
                  }}
                />
              </View>

              {/* Notes Input */}
              <View style={{marginBottom: 16}}>
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: '600',
                    color: theme.colors.foreground,
                    marginBottom: 8,
                  }}>
                  Notes
                </Text>
                <TextInput
                  placeholder="Add notes (optional)"
                  placeholderTextColor={theme.colors.muted}
                  value={newEventNotes}
                  onChangeText={setNewEventNotes}
                  multiline
                  numberOfLines={4}
                  style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: 12,
                    padding: 16,
                    fontSize: 16,
                    color: theme.colors.foreground,
                    minHeight: 100,
                    textAlignVertical: 'top',
                  }}
                />
              </View>
            </View>
          </SafeAreaView>
        </View>
      </Modal>

      {/* Upcoming Modal */}
      <Modal
        visible={upcomingModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setUpcomingModalVisible(false)}>
        <LinearGradient
          colors={[
            theme.colors.background,
            theme.colors.background === '#000000' ||
            theme.colors.background === '#000'
              ? '#0a0a1a'
              : theme.colors.background,
            theme.colors.background === '#000000' ||
            theme.colors.background === '#000'
              ? '#0f0f2a'
              : theme.colors.background,
          ]}
          start={{x: 0, y: 0}}
          end={{x: 1, y: 1}}
          style={{flex: 1}}>
          <SafeAreaView style={{flex: 1}}>
            <View style={{flex: 1}}>
              {/* Glossy Modal Header */}
              <BlurView
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  zIndex: 10,
                }}
                blurType={
                  theme.colors.background === '#000000' ||
                  theme.colors.background === '#000'
                    ? 'dark'
                    : 'light'
                }
                blurAmount={20}
                reducedTransparencyFallbackColor="transparent">
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingHorizontal: 20,
                    paddingVertical: 16,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: 'rgba(255,255,255,0.1)',
                  }}>
                  <View style={{width: 60}} />
                  <View style={{alignItems: 'center'}}>
                    <Text
                      style={{
                        fontSize: 17,
                        fontWeight: '600',
                        color: theme.colors.foreground,
                        letterSpacing: 0.5,
                      }}>
                      Upcoming
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => {
                      h('impactLight');
                      setUpcomingModalVisible(false);
                    }}
                    style={{
                      width: 60,
                      alignItems: 'flex-end',
                      paddingVertical: 4,
                      paddingHorizontal: 8,
                    }}>
                    <Text
                      style={{
                        fontSize: 17,
                        fontWeight: '600',
                        color: theme.colors.primary,
                      }}>
                      Done
                    </Text>
                  </TouchableOpacity>
                </View>
              </BlurView>

              {/* 7-Day Outlook Hero Header */}
              <View
                style={{
                  paddingHorizontal: 20,
                  paddingTop: 70,
                  paddingBottom: 16,
                }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}></View>
                <Text
                  style={{
                    fontSize: 32,
                    fontWeight: '800',
                    color: theme.colors.foreground,
                    letterSpacing: -0.5,
                  }}>
                  7-Day Outlook
                </Text>
                <Text
                  style={{
                    fontSize: 15,
                    color: theme.colors.foreground,
                    marginTop: 6,
                    lineHeight: 20,
                    fontWeight: '600',
                  }}>
                  Your Week Ahead
                </Text>
              </View>

              {/* Upcoming Days List */}
              <ScrollView
                style={{flex: 1}}
                contentContainerStyle={{
                  paddingBottom: 40,
                  paddingHorizontal: 20,
                }}
                showsVerticalScrollIndicator={false}>
                {(() => {
                  // Get next 7 days
                  const days: {date: Date; dateKey: string; label: string}[] =
                    [];
                  const today = new Date();
                  for (let i = 0; i < 7; i++) {
                    const d = new Date(today);
                    d.setDate(today.getDate() + i);
                    const dateKey = getLocalDateKey(d.toISOString());
                    let label = '';
                    if (i === 0) label = 'Today';
                    else if (i === 1) label = 'Tomorrow';
                    else
                      label = d.toLocaleDateString('en-US', {weekday: 'long'});
                    days.push({date: d, dateKey, label});
                  }

                  // Filter to days that have events or outfits
                  const daysWithContent = days.map(day => {
                    const dayEvents = calendarEvents.filter(
                      e =>
                        getLocalDateKey(e.start_date) === day.dateKey &&
                        !e.title?.startsWith('Trip: '),
                    );
                    const dayOutfits = scheduledOutfits.filter(
                      o => getLocalDateKey(o.plannedDate) === day.dateKey,
                    );
                    return {...day, events: dayEvents, outfits: dayOutfits};
                  });

                  const hasAnyContent = daysWithContent.some(
                    d => d.events.length > 0 || d.outfits.length > 0,
                  );

                  if (!hasAnyContent) {
                    return (
                      <View
                        style={{
                          flex: 1,
                          alignItems: 'center',
                          justifyContent: 'center',
                          paddingTop: 60,
                          paddingHorizontal: 20,
                        }}>
                        <View
                          style={{
                            width: 100,
                            height: 100,
                            borderRadius: 50,
                            backgroundColor: 'rgba(102, 126, 234, 0.15)',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginBottom: 20,
                          }}>
                          <MaterialIcons
                            name="event-available"
                            size={48}
                            color="#667eea"
                          />
                        </View>
                        <Text
                          style={{
                            fontSize: 20,
                            fontWeight: '700',
                            color: theme.colors.foreground,
                            marginBottom: 8,
                          }}>
                          All Clear!
                        </Text>
                        <Text
                          style={{
                            fontSize: 15,
                            color: theme.colors.muted,
                            textAlign: 'center',
                            lineHeight: 22,
                          }}>
                          Nothing scheduled for the next 7 days
                        </Text>
                      </View>
                    );
                  }

                  return daysWithContent.map((day, idx) => {
                    if (day.events.length === 0 && day.outfits.length === 0) {
                      return null;
                    }

                    return (
                      <Animatable.View
                        key={day.dateKey}
                        animation="fadeInUp"
                        delay={idx * 100}
                        duration={400}>
                        {/* Glossy Day Header */}
                        <View
                          style={{
                            paddingTop: idx === 0 ? 8 : 16,
                            paddingBottom: 8,
                          }}>
                          <View
                            style={{
                              flexDirection: 'row',
                              alignItems: 'baseline',
                            }}>
                            <Text
                              style={{
                                fontSize: 24,
                                fontWeight: '800',
                                color: theme.colors.foreground,
                                letterSpacing: -0.5,
                              }}>
                              {day.label}
                            </Text>
                            <Text
                              style={{
                                fontSize: 14,
                                color: theme.colors.muted,
                                marginLeft: 10,
                                fontWeight: '500',
                              }}>
                              {day.date.toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                              })}
                            </Text>
                          </View>
                        </View>

                        {/* Events for this day - Glassmorphic Cards */}
                        {day.events.map((event, eIdx) => (
                          <TouchableOpacity
                            key={event.event_id || event.id || eIdx}
                            onPress={() => {
                              h('impactLight');
                              // Close modal and navigate to this day
                              setUpcomingModalVisible(false);
                              setSelectedDate(day.dateKey);
                            }}
                            activeOpacity={0.8}
                            style={{
                              borderRadius: 16,
                              overflow: 'hidden',
                              shadowColor: '#FFD700',
                              shadowOffset: {width: 0, height: 4},
                              shadowOpacity: 0.15,
                              shadowRadius: 12,
                              elevation: 6,
                            }}>
                            <LinearGradient
                              colors={[
                                'rgba(255, 215, 0, 0.15)',
                                'rgba(255, 193, 7, 0.08)',
                                'rgba(255, 215, 0, 0.03)',
                              ]}
                              start={{x: 0, y: 0}}
                              end={{x: 1, y: 1}}
                              style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                borderWidth: 1,
                                borderColor: 'rgba(255, 215, 0, 0.2)',
                                borderRadius: 16,
                                height: 70,
                                marginBottom: 8,
                              }}>
                              <View
                                style={{
                                  width: 44,
                                  height: 44,
                                  borderRadius: 12,
                                  backgroundColor: 'rgba(255, 215, 0, 0.2)',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  marginLeft: 14,
                                  marginRight: 12,
                                }}>
                                <MaterialIcons
                                  name="event"
                                  size={22}
                                  color="#FFD700"
                                />
                              </View>
                              <View style={{flex: 1}}>
                                <Text
                                  style={{
                                    fontSize: 16,
                                    fontWeight: '700',
                                    color: theme.colors.foreground,
                                    letterSpacing: -0.3,
                                  }}>
                                  {event.title}
                                </Text>
                                <Text
                                  style={{
                                    fontSize: 13,
                                    color: theme.colors.muted,
                                    marginTop: 3,
                                    fontWeight: '500',
                                  }}>
                                  {formatLocalTime(event.start_date)}
                                  {event.end_date &&
                                    ` → ${formatLocalTime(event.end_date)}`}
                                </Text>
                                {event.location ? (
                                  <View
                                    style={{
                                      flexDirection: 'row',
                                      alignItems: 'center',
                                      marginTop: 4,
                                    }}>
                                    <MaterialIcons
                                      name="place"
                                      size={12}
                                      color={theme.colors.muted}
                                    />
                                    <Text
                                      style={{
                                        fontSize: 12,
                                        color: theme.colors.muted,
                                        marginLeft: 4,
                                      }}>
                                      {event.location}
                                    </Text>
                                  </View>
                                ) : null}
                              </View>
                              <MaterialIcons
                                name="chevron-right"
                                size={22}
                                color="rgba(255, 217, 0, 1)"
                              />
                            </LinearGradient>
                          </TouchableOpacity>
                        ))}

                        {/* Outfits for this day - Glassmorphic Cards */}
                        {day.outfits.map((outfit, oIdx) => (
                          <TouchableOpacity
                            key={outfit.id || oIdx}
                            onPress={() => {
                              h('impactLight');
                              // Close modal and navigate to this day
                              setUpcomingModalVisible(false);
                              setSelectedDate(day.dateKey);
                            }}
                            activeOpacity={0.8}
                            style={{
                              marginBottom: 12,
                              borderRadius: 16,
                              overflow: 'hidden',
                              shadowColor:
                                outfit.type === 'ai' ? '#405de6' : '#00c6ae',
                              shadowOffset: {width: 0, height: 4},
                              shadowOpacity: 0.15,
                              shadowRadius: 12,
                              elevation: 6,
                            }}>
                            <LinearGradient
                              colors={
                                outfit.type === 'ai'
                                  ? [
                                      'rgba(64, 93, 230, 0.15)',
                                      'rgba(64, 93, 230, 0.08)',
                                      'rgba(64, 93, 230, 0.03)',
                                    ]
                                  : [
                                      'rgba(0, 198, 174, 0.15)',
                                      'rgba(0, 198, 174, 0.08)',
                                      'rgba(0, 198, 174, 0.03)',
                                    ]
                              }
                              start={{x: 0, y: 0}}
                              end={{x: 1, y: 1}}
                              style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                borderWidth: 1,
                                borderColor:
                                  outfit.type === 'ai'
                                    ? 'rgba(64, 93, 230, 0.2)'
                                    : 'rgba(0, 198, 174, 0.2)',
                                borderRadius: 16,
                                height: 70,
                              }}>
                              {(outfit.allItems?.[0]?.image ?? outfit.top?.image) ? (
                                <Image
                                  source={{uri: outfit.allItems?.[0]?.image ?? outfit.top?.image}}
                                  style={{
                                    width: 52,
                                    height: 52,
                                    borderRadius: 12,
                                    marginRight: 14,
                                    objectFit: 'contain',
                                  }}
                                />
                              ) : (
                                <View
                                  style={{
                                    width: 44,
                                    height: 44,
                                    borderRadius: 12,
                                    backgroundColor:
                                      outfit.type === 'ai'
                                        ? 'rgba(64, 93, 230, 0.2)'
                                        : 'rgba(0, 198, 174, 0.2)',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    marginLeft: 14,
                                    marginRight: 14,
                                  }}>
                                  <MaterialIcons
                                    name={
                                      outfit.type === 'ai'
                                        ? 'auto-awesome'
                                        : 'checkroom'
                                    }
                                    size={22}
                                    color={
                                      outfit.type === 'ai'
                                        ? '#405de6'
                                        : '#00c6ae'
                                    }
                                  />
                                </View>
                              )}
                              <View style={{flex: 1}}>
                                <Text
                                  style={{
                                    fontSize: 16,
                                    fontWeight: '700',
                                    color: theme.colors.foreground,
                                    letterSpacing: -0.3,
                                  }}>
                                  {outfit.name || 'Scheduled Outfit'}
                                </Text>
                                <Text
                                  style={{
                                    fontSize: 13,
                                    color: theme.colors.muted,
                                    marginTop: 3,
                                    fontWeight: '500',
                                  }}>
                                  {outfit.type === 'ai'
                                    ? 'AI Suggestion'
                                    : 'Custom Outfit'}
                                </Text>
                              </View>
                              <MaterialIcons
                                name="chevron-right"
                                size={22}
                                color={
                                  outfit.type === 'ai'
                                    ? 'rgba(64, 93, 230, 0.6)'
                                    : 'rgba(0, 198, 174, 0.6)'
                                }
                              />
                            </LinearGradient>
                          </TouchableOpacity>
                        ))}
                      </Animatable.View>
                    );
                  });
                })()}
              </ScrollView>
            </View>
          </SafeAreaView>
        </LinearGradient>
      </Modal>
    </SafeAreaView>
  );
}

//////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   ScrollView,
//   Image,
//   StyleSheet,
//   Animated,
//   ActivityIndicator,
//   KeyboardAvoidingView,
//   Platform,
// } from 'react-native';
// import {useAuth0} from 'react-native-auth0';
// import {Calendar, DateObject} from 'react-native-calendars';
// import {useAppTheme} from '../context/ThemeContext';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import {moderateScale} from '../utils/scale';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import {tokens} from '../styles/tokens/tokens';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {syncNativeCalendarToBackend} from '../utils/calendarSync';
// import * as Animatable from 'react-native-animatable';

// // ───────── helpers ─────────
// const getLocalDateKey = (iso: string) => {
//   const d = new Date(iso);
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, '0');
//   const day = String(d.getDate()).padStart(2, '0');
//   return `${y}-${m}-${day}`;
// };

// const formatLocalTime = (iso?: string) => {
//   if (!iso) return '';
//   return new Date(iso).toLocaleTimeString(undefined, {
//     hour: 'numeric',
//     minute: '2-digit',
//     timeZoneName: 'short',
//   });
// };

// const h = (type: string) =>
//   ReactNativeHapticFeedback.trigger(type, {
//     enableVibrateFallback: true,
//     ignoreAndroidSystemSettings: false,
//   });

// // ───────── main ─────────
// export default function OutfitPlannerScreen() {
//   const {user} = useAuth0();
//   const userId = useUUID() || user?.sub || '';
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const insets = useSafeAreaInsets();
//   const fadeAnim = useRef(new Animated.Value(0)).current;

//   const [calendarEvents, setCalendarEvents] = useState<any[]>([]);
//   const [scheduledOutfits, setScheduledOutfits] = useState<any[]>([]);
//   const [selectedDate, setSelectedDate] = useState<string | null>(null);
//   const [modalVisible, setModalVisible] = useState(false);

//   const [aiPromptVisible, setAiPromptVisible] = useState(false);
//   const [promptEvent, setPromptEvent] = useState<any>(null);
//   const [loadingSuggestion, setLoadingSuggestion] = useState(false);
//   const [aiOutfit, setAiOutfit] = useState<any>(null);

//   // ───────── animations ─────────
//   useEffect(() => {
//     Animated.timing(fadeAnim, {
//       toValue: 1,
//       duration: 650,
//       useNativeDriver: true,
//     }).start();
//   }, []);

//   // ───────── sync native iOS calendar ─────────
//   useEffect(() => {
//     if (userId) {
//       syncNativeCalendarToBackend(userId);
//       console.log('⚠️ Calendar sync skipped (API disabled)');
//     }
//   }, [userId]);

//   // ───────── fetch calendar + outfits ─────────
//   useEffect(() => {
//     if (!userId) return;
//     (async () => {
//       try {
//         const res = await fetch(`${API_BASE_URL}/calendar/user/${userId}`);
//         const json = await res.json();
//         setCalendarEvents(json.events || []);
//       } catch (err) {
//         console.warn('❌ Failed to load calendar events:', err);
//       }
//     })();
//   }, [userId]);

//   useEffect(() => {
//     if (!userId) return;
//     const fetchData = async () => {
//       try {
//         const [aiRes, customRes, scheduledRes] = await Promise.all([
//           fetch(`${API_BASE_URL}/outfit/suggestions/${userId}`),
//           fetch(`${API_BASE_URL}/outfit/custom/${userId}`),
//           fetch(`${API_BASE_URL}/scheduled-outfits/${userId}`),
//         ]);
//         const [aiData, customData, scheduledData] = await Promise.all([
//           aiRes.json(),
//           customRes.json(),
//           scheduledRes.json(),
//         ]);

//         const scheduleMap: Record<string, string> = {};
//         for (const s of scheduledData) {
//           if (s.ai_outfit_id) scheduleMap[s.ai_outfit_id] = s.scheduled_for;
//           else if (s.custom_outfit_id)
//             scheduleMap[s.custom_outfit_id] = s.scheduled_for;
//         }

//         const normalizeImageUrl = (url?: string | null) =>
//           url?.startsWith('http') ? url : `${API_BASE_URL}${url || ''}`;

//         const normalize = (o: any, isCustom: boolean) => {
//           const plannedDate = scheduleMap[o.id];
//           if (!plannedDate) return null;
//           return {
//             ...o,
//             plannedDate,
//             type: isCustom ? 'custom' : 'ai',
//             top: o.top
//               ? {...o.top, image: normalizeImageUrl(o.top.image)}
//               : null,
//             bottom: o.bottom
//               ? {...o.bottom, image: normalizeImageUrl(o.bottom.image)}
//               : null,
//             shoes: o.shoes
//               ? {...o.shoes, image: normalizeImageUrl(o.shoes.image)}
//               : null,
//           };
//         };

//         const outfits = [
//           ...aiData.map(o => normalize(o, false)),
//           ...customData.map(o => normalize(o, true)),
//         ].filter(Boolean);
//         setScheduledOutfits(outfits);
//       } catch (err) {
//         console.error('❌ Failed to load outfits:', err);
//       }
//     };
//     fetchData();
//   }, [userId]);

//   // ───────── mark dots ─────────
//   const allMarks: Record<string, any> = {};
//   for (const outfit of scheduledOutfits) {
//     const date = getLocalDateKey(outfit.plannedDate);
//     if (!allMarks[date]) allMarks[date] = {dots: []};
//     allMarks[date].dots.push({
//       color: outfit.type === 'ai' ? '#405de6' : '#00c6ae',
//     });
//   }
//   for (const ev of calendarEvents) {
//     const date = getLocalDateKey(ev.start_date);
//     if (!allMarks[date]) allMarks[date] = {dots: []};
//     allMarks[date].dots.push({color: '#FFD700'});
//   }

//   // ───────── find upcoming events (for AI prompt) ─────────
//   useEffect(() => {
//     if (!calendarEvents.length) return;
//     const now = new Date();
//     const upcoming = calendarEvents.find(ev => {
//       const start = new Date(ev.start_date);
//       const hoursDiff = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
//       const title = ev.title?.toLowerCase() || '';
//       const isRelevant =
//         /(dinner|party|event|drinks|wedding|meeting|launch)/.test(title);
//       return isRelevant && hoursDiff >= 0 && hoursDiff < 24;
//     });
//     if (upcoming) {
//       setPromptEvent(upcoming);
//       setAiPromptVisible(true);
//       h('impactMedium');
//     }
//   }, [calendarEvents]);

//   const handleStyleIt = async () => {
//     if (!promptEvent) return;
//     try {
//       setLoadingSuggestion(true);
//       const prompt = `Outfit suggestion for ${promptEvent.title} at ${
//         promptEvent.location || 'a venue'
//       } starting ${formatLocalTime(promptEvent.start_date)}.`;

//       const res = await fetch(`${API_BASE_URL}/ai/suggest`, {
//         method: 'POST',
//         headers: {'Content-Type': 'application/json'},
//         body: JSON.stringify({user_id: userId, prompt}),
//       });
//       const json = await res.json();
//       setAiOutfit(json);
//       setLoadingSuggestion(false);
//       h('success');
//     } catch (err) {
//       console.error('❌ AI suggest error:', err);
//       setLoadingSuggestion(false);
//     }
//   };

//   // const handleStyleIt = () => {
//   //   console.log(
//   //     '⚠️ AI service temporarily disabled — skipping /ai/suggest call.',
//   //   );
//   //   setAiPromptVisible(false); // just close the prompt for now
//   // };

//   // ───────── render ─────────
//   const styles = StyleSheet.create({
//     card: {
//       borderRadius: 16,
//       padding: 14,
//       marginBottom: 6,
//       backgroundColor: theme.colors.surface3,
//       borderWidth: StyleSheet.hairlineWidth,
//       borderColor: theme.colors.surfaceBorder,
//     },
//     name: {
//       color: theme.colors.foreground,
//       fontSize: 16,
//       fontWeight: tokens.fontWeight.semiBold,
//     },
//     time: {color: theme.colors.foreground2, marginTop: 4, fontSize: 13},
//     notes: {fontStyle: 'italic', color: theme.colors.foreground2, marginTop: 8},
//     row: {flexDirection: 'row', marginTop: 10},
//     thumb: {
//       width: 68,
//       height: 68,
//       borderRadius: 12,
//       marginRight: 8,
//       backgroundColor: theme.colors.surface,
//     },
//     promptBox: {
//       position: 'absolute',
//       bottom: 30,
//       left: 20,
//       right: 20,
//       borderRadius: 16,
//       backgroundColor: theme.colors.surface2,
//       padding: 16,
//       shadowColor: '#000',
//       shadowOpacity: 0.25,
//       shadowRadius: 10,
//       elevation: 6,
//     },
//     promptText: {
//       color: theme.colors.foreground,
//       fontSize: 16,
//       fontWeight: '600',
//       marginBottom: 12,
//       textAlign: 'center',
//     },
//     btn: {
//       borderRadius: 10,
//       paddingVertical: 10,
//       backgroundColor: theme.colors.button1,
//       alignItems: 'center',
//     },
//     btnText: {color: theme.colors.foreground, fontWeight: '600', fontSize: 15},
//   });

//   const outfitsByDate = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate);
//     if (!acc[date]) acc[date] = [];
//     acc[date].push(outfit);
//     return acc;
//   }, {} as Record<string, any[]>);

//   const handleDayPress = (day: DateObject) => {
//     setSelectedDate(day.dateString);
//     setModalVisible(true);
//     h('selection');
//   };

//   return (
//     <SafeAreaView style={{flex: 1, backgroundColor: theme.colors.background}}>
//       <View
//         style={{
//           height: insets.top + 10, // ✅ matches GlobalHeader spacing
//           backgroundColor: theme.colors.background,
//         }}
//       />
//       <Text style={[globalStyles.header, {marginBottom: 8}]}>
//         Planned Outfits
//       </Text>

//       <Animated.View style={{opacity: fadeAnim, flex: 1}}>
//         <Calendar
//           onDayPress={handleDayPress}
//           markedDates={{
//             ...allMarks,
//             ...(selectedDate
//               ? {
//                   [selectedDate]: {
//                     selected: true,
//                     selectedColor: theme.colors.primary,
//                   },
//                 }
//               : {}),
//           }}
//           markingType="multi-dot"
//           theme={{
//             calendarBackground: theme.colors.background,
//             textSectionTitleColor: theme.colors.foreground2,
//             dayTextColor: theme.colors.foreground,
//             todayTextColor: theme.colors.primary,
//             selectedDayBackgroundColor: theme.colors.primary,
//             selectedDayTextColor: '#fff',
//             arrowColor: theme.colors.primary,
//             monthTextColor: theme.colors.primary,
//             textMonthFontWeight: tokens.fontWeight.bold,
//             textDayFontSize: 16,
//             textMonthFontSize: 18,
//             textDayHeaderFontSize: 14,
//             dotColor: theme.colors.primary,
//             selectedDotColor: '#fff',
//             disabledArrowColor: '#444',
//           }}
//         />

//         {/* Details */}
//         {modalVisible && (
//           <ScrollView
//             style={{
//               flex: 1,
//               paddingHorizontal: moderateScale(tokens.spacing.md1),
//             }}
//             contentContainerStyle={{paddingBottom: insets.bottom + 8}}>
//             {(outfitsByDate[selectedDate!] || []).map((o, index) => (
//               <View key={index} style={styles.card}>
//                 <Text style={styles.name}>{o.name || 'Unnamed Outfit'}</Text>
//                 <Text style={styles.time}>
//                   🕒 {formatLocalTime(o.plannedDate)}
//                 </Text>
//                 <View style={styles.row}>
//                   {[o.top, o.bottom, o.shoes].map(
//                     item =>
//                       item?.image && (
//                         <Image
//                           key={item.id}
//                           source={{uri: item.image}}
//                           style={styles.thumb}
//                           resizeMode="cover"
//                         />
//                       ),
//                   )}
//                 </View>
//                 {o.notes ? <Text style={styles.notes}>{o.notes}</Text> : null}
//               </View>
//             ))}

//             {calendarEvents
//               .filter(e => getLocalDateKey(e.start_date) === selectedDate)
//               .map(ev => (
//                 <AppleTouchFeedback
//                   key={ev.id}
//                   onPress={() => h('impactLight')}>
//                   <View style={styles.card}>
//                     <Text style={styles.name}>{ev.title}</Text>
//                     <Text style={styles.time}>
//                       {formatLocalTime(ev.start_date)} →{' '}
//                       {formatLocalTime(ev.end_date)}
//                     </Text>
//                     {ev.location ? (
//                       <Text style={styles.notes}>📍 {ev.location}</Text>
//                     ) : null}
//                     {ev.notes ? (
//                       <Text style={styles.notes}>{ev.notes}</Text>
//                     ) : null}
//                   </View>
//                 </AppleTouchFeedback>
//               ))}
//           </ScrollView>
//         )}
//       </Animated.View>

//       {aiPromptVisible && promptEvent && (
//         <Animatable.View
//           animation="fadeInUp"
//           duration={450}
//           style={styles.promptBox}>
//           {!aiOutfit ? (
//             <>
//               <Text style={[styles.promptText, {marginBottom: 6}]}>
//                 You’ve got{' '}
//                 <Text style={{fontWeight: '700'}}>{promptEvent.title}</Text>{' '}
//                 coming up
//               </Text>

//               {/* 📅 Date and Time */}
//               <Text
//                 style={[styles.time, {textAlign: 'center', marginBottom: 16}]}>
//                 {new Date(promptEvent.start_date).toLocaleDateString(
//                   undefined,
//                   {
//                     weekday: 'long',
//                     month: 'short',
//                     day: 'numeric',
//                   },
//                 )}{' '}
//                 • {formatLocalTime(promptEvent.start_date)} →{' '}
//                 {formatLocalTime(promptEvent.end_date)}
//               </Text>

//               {/* 📍 Location (if available) */}
//               {promptEvent.location ? (
//                 <Text
//                   style={[
//                     styles.notes,
//                     {
//                       textAlign: 'center',
//                       marginBottom: 10,
//                       color: theme.colors.foreground2,
//                     },
//                   ]}>
//                   📍 {promptEvent.location}
//                 </Text>
//               ) : null}
//               <AppleTouchFeedback onPress={handleStyleIt}>
//                 <View style={styles.btn}>
//                   {loadingSuggestion ? (
//                     <ActivityIndicator color={theme.colors.foreground} />
//                   ) : (
//                     <Text style={styles.btnText}>Yes, Style It</Text>
//                   )}
//                 </View>
//               </AppleTouchFeedback>

//               {/* ❌ Cancel / No button */}
//               <AppleTouchFeedback
//                 onPress={() => {
//                   setAiPromptVisible(false);
//                   setPromptEvent(null);
//                   h('impactLight');
//                 }}>
//                 <View
//                   style={[
//                     styles.btn,
//                     {
//                       marginTop: 8,
//                       backgroundColor: theme.colors.surface3,
//                     },
//                   ]}>
//                   <Text
//                     style={[
//                       styles.btnText,
//                       {color: theme.colors.foreground2, fontWeight: '500'},
//                     ]}>
//                     No, Not Now
//                   </Text>
//                 </View>
//               </AppleTouchFeedback>
//             </>
//           ) : (
//             <>
//               <Text style={styles.promptText}>Your Styled Look</Text>
//               <ScrollView horizontal showsHorizontalScrollIndicator={false}>
//                 {[aiOutfit.top, aiOutfit.bottom, aiOutfit.shoes].map(
//                   (piece: any, idx: number) =>
//                     piece?.image && (
//                       <Image
//                         key={idx}
//                         source={{uri: piece.image}}
//                         style={[styles.thumb, {width: 90, height: 90}]}
//                       />
//                     ),
//                 )}
//               </ScrollView>
//               <AppleTouchFeedback
//                 onPress={() => {
//                   setAiPromptVisible(false);
//                   setAiOutfit(null);
//                 }}>
//                 <View
//                   style={[
//                     styles.btn,
//                     {marginTop: 10, backgroundColor: theme.colors.surface3},
//                   ]}>
//                   <Text
//                     style={[styles.btnText, {color: theme.colors.foreground}]}>
//                     Close
//                   </Text>
//                 </View>
//               </AppleTouchFeedback>
//             </>
//           )}
//         </Animatable.View>
//       )}
//     </SafeAreaView>
//   );
// }

///////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   ScrollView,
//   Image,
//   StyleSheet,
//   Animated,
// } from 'react-native';
// import {useAuth0} from 'react-native-auth0';
// import {Calendar, DateObject} from 'react-native-calendars';
// import {useAppTheme} from '../context/ThemeContext';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
// import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
// import {GradientBackground} from '../components/LinearGradientComponents/GradientBackground';

// type WardrobeItem = {
//   id: string;
//   name: string;
//   image: string;
//   mainCategory: string;
//   subCategory: string;
//   material: string;
//   fit: string;
//   color: string;
//   size: string;
//   notes: string;
// };

// type SavedOutfit = {
//   id: string;
//   name?: string;
//   top: WardrobeItem | null;
//   bottom: WardrobeItem | null;
//   shoes: WardrobeItem | null;
//   createdAt: string;
//   tags?: string[];
//   notes?: string;
//   rating?: number;
//   favorited?: boolean;
//   plannedDate?: string;
//   type?: 'custom' | 'ai';
// };

// // ───────── helpers ─────────
// const getLocalDateKey = (iso: string) => {
//   const d = new Date(iso);
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, '0');
//   const day = String(d.getDate()).padStart(2, '0');
//   return `${y}-${m}-${day}`;
// };

// const formatLocalTime = (iso?: string) => {
//   if (!iso) return '';
//   return new Date(iso).toLocaleTimeString(undefined, {
//     hour: 'numeric',
//     minute: '2-digit',
//     timeZoneName: 'short',
//   });
// };

// const h = (type: string) =>
//   ReactNativeHapticFeedback.trigger(type, {
//     enableVibrateFallback: true,
//     ignoreAndroidSystemSettings: false,
//   });

// export default function OutfitPlannerScreen() {
//   const {user} = useAuth0();
//   const userId = useUUID() || user?.sub || '';
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const colors = theme.colors;

//   // ✨ Fade animation for content
//   const fadeAnim = useRef(new Animated.Value(0)).current;

//   useEffect(() => {
//     Animated.timing(fadeAnim, {
//       toValue: 1,
//       duration: 650,
//       useNativeDriver: true,
//     }).start();
//   }, []);

//   const insets = useSafeAreaInsets();

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     card: {
//       borderRadius: 16,
//       padding: 14,
//       marginBottom: 6,
//       backgroundColor: theme.colors.surface3 ?? theme.colors.surface3,
//       borderWidth: StyleSheet.hairlineWidth,
//       borderColor: theme.colors.input2 ?? theme.colors.surfaceBorder,
//       display: 'flex',
//     },
//     name: {
//       color: theme.colors.foreground,
//       fontSize: 16,
//       fontWeight: '600',
//     },
//     time: {color: theme.colors.foreground2, marginTop: 4, fontSize: 13},
//     row: {flexDirection: 'row', marginTop: 10},
//     thumb: {
//       width: 68,
//       height: 68,
//       borderRadius: 12,
//       marginRight: 8,
//       borderWidth: theme.borderWidth?.md ?? StyleSheet.hairlineWidth,
//       borderColor: theme.colors.surfaceBorder,
//       backgroundColor: theme.colors.surface,
//     },
//     notes: {
//       fontStyle: 'italic',
//       color: theme.colors.foreground2,
//       marginTop: 8,
//       lineHeight: 18,
//     },
//     rating: {color: '#FFD700', marginTop: 6, fontSize: 16},
//   });

//   const [scheduledOutfits, setScheduledOutfits] = useState<SavedOutfit[]>([]);
//   const [selectedDate, setSelectedDate] = useState<string | null>(null);
//   const [modalVisible, setModalVisible] = useState(false);

//   const normalizeImageUrl = (url: string | undefined | null): string => {
//     if (!url) return '';
//     return url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
//   };

//   useEffect(() => {
//     if (!userId) return;

//     const fetchData = async () => {
//       try {
//         const [aiRes, customRes, scheduledRes] = await Promise.all([
//           fetch(`${API_BASE_URL}/outfit/suggestions/${userId}`),
//           fetch(`${API_BASE_URL}/outfit/custom/${userId}`),
//           fetch(`${API_BASE_URL}/scheduled-outfits/${userId}`),
//         ]);

//         if (!aiRes.ok || !customRes.ok || !scheduledRes.ok) {
//           throw new Error('Failed to fetch outfit schedule data');
//         }

//         const [aiData, customData, scheduledData] = await Promise.all([
//           aiRes.json(),
//           customRes.json(),
//           scheduledRes.json(),
//         ]);

//         const scheduleMap: Record<string, string> = {};
//         for (const s of scheduledData) {
//           if (s.ai_outfit_id) {
//             scheduleMap[s.ai_outfit_id] = s.scheduled_for;
//           } else if (s.custom_outfit_id) {
//             scheduleMap[s.custom_outfit_id] = s.scheduled_for;
//           }
//         }

//         const normalize = (o: any, isCustom: boolean): SavedOutfit | null => {
//           const id = o.id;
//           const plannedDate = scheduleMap[id];
//           if (!plannedDate) return null;

//           return {
//             id,
//             name: o.name || '',
//             top: o.top
//               ? {
//                   id: o.top.id,
//                   name: o.top.name,
//                   image: normalizeImageUrl(o.top.image || o.top.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             bottom: o.bottom
//               ? {
//                   id: o.bottom.id,
//                   name: o.bottom.name,
//                   image: normalizeImageUrl(
//                     o.bottom.image || o.bottom.image_url,
//                   ),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             shoes: o.shoes
//               ? {
//                   id: o.shoes.id,
//                   name: o.shoes.name,
//                   image: normalizeImageUrl(o.shoes.image || o.shoes.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             createdAt: o.created_at
//               ? new Date(o.created_at).toISOString()
//               : new Date().toISOString(),
//             tags: o.tags || [],
//             notes: o.notes || '',
//             rating: o.rating ?? undefined,
//             favorited: false,
//             plannedDate,
//             type: isCustom ? 'custom' : 'ai',
//           };
//         };

//         const outfits = [
//           ...aiData.map(o => normalize(o, false)),
//           ...customData.map(o => normalize(o, true)),
//         ].filter(Boolean) as SavedOutfit[];

//         setScheduledOutfits(outfits);
//       } catch (err) {
//         console.error('❌ Failed to load calendar outfits:', err);
//       }
//     };

//     fetchData();
//   }, [userId]);

//   const markedDates = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = {dots: []};
//     acc[date].dots.push({
//       color: outfit.type === 'ai' ? '#405de6' : '#00c6ae',
//     });
//     return acc;
//   }, {} as Record<string, any>);

//   const outfitsByDate = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = [];
//     acc[date].push(outfit);
//     return acc;
//   }, {} as Record<string, SavedOutfit[]>);

//   const handleDayPress = (day: DateObject) => {
//     setSelectedDate(day.dateString);
//     setModalVisible(true);
//     h('selection');
//   };

//   return (
//     // <GradientBackground>
//     <SafeAreaView
//       style={{
//         flex: 1,
//         backgroundColor: theme.colors.background,
//         paddingBottom: 0, // ✅ prevent bottom extra padding
//       }}
//       edges={['top', 'left', 'right']} // 👈 exclude bottom
//     >
//       <Text style={[globalStyles.header, {marginBottom: 8}]}>
//         Planned Outfits
//       </Text>

//       <Animated.View style={{opacity: fadeAnim, flex: 1}}>
//         {/* 📅 Calendar with bottom border */}
//         <View
//           style={{
//             borderBottomWidth: 1,
//             borderBottomColor: theme.colors.surfaceBorder,
//           }}>
//           <Calendar
//             onDayPress={handleDayPress}
//             markedDates={{
//               ...markedDates,
//               ...(selectedDate
//                 ? {
//                     [selectedDate]: {
//                       selected: true,
//                       selectedColor: theme.colors.primary,
//                     },
//                   }
//                 : {}),
//             }}
//             markingType="multi-dot"
//             theme={{
//               calendarBackground: theme.colors.background,
//               textSectionTitleColor: theme.colors.foreground2,
//               dayTextColor: theme.colors.foreground,
//               todayTextColor: theme.colors.primary,
//               selectedDayBackgroundColor: theme.colors.primary,
//               selectedDayTextColor: '#fff',
//               arrowColor: theme.colors.primary,
//               monthTextColor: theme.colors.primary,
//               textMonthFontWeight: 'bold',
//               textDayFontSize: 16,
//               textMonthFontSize: 18,
//               textDayHeaderFontSize: 14,
//               dotColor: theme.colors.primary,
//               selectedDotColor: '#fff',
//               disabledArrowColor: '#444',
//             }}
//           />
//         </View>

//         {/* 🪄 Directly below calendar */}
//         {modalVisible && (
//           <View
//             style={{
//               flex: 1,
//               marginTop: 0,
//               paddingTop: 2,
//               paddingHorizontal: 16,
//             }}>
//             <View
//               style={{
//                 flexDirection: 'row',
//                 justifyContent: 'space-between',
//                 alignItems: 'center',
//               }}>
//               <ScrollView
//                 showsVerticalScrollIndicator={false}
//                 contentContainerStyle={{
//                   paddingTop: 4,
//                   paddingBottom: insets.bottom + 8, // 👈 ensures no black gap above nav
//                 }}
//                 style={{flexGrow: 1}}>
//                 {(outfitsByDate[selectedDate!] || []).map((o, index) => (
//                   <View key={index} style={styles.card}>
//                     <View>
//                       <Text style={styles.name}>
//                         {o.name?.trim() || 'Unnamed Outfit'}
//                       </Text>
//                       <Text style={styles.time}>
//                         🕒 {formatLocalTime(o.plannedDate)}
//                       </Text>

//                       <View style={styles.row}>
//                         {[o.top, o.bottom, o.shoes].map(item =>
//                           item?.image ? (
//                             <Image
//                               key={item.id}
//                               source={{uri: item.image}}
//                               style={styles.thumb}
//                               resizeMode="cover"
//                             />
//                           ) : null,
//                         )}
//                       </View>

//                       {o.notes ? (
//                         <Text style={styles.notes}>{o.notes}</Text>
//                       ) : null}

//                       {typeof o.rating === 'number' && (
//                         <Text style={styles.rating}>
//                           {'⭐'.repeat(o.rating)} {'☆'.repeat(5 - o.rating)}
//                         </Text>
//                       )}
//                     </View>
//                   </View>
//                 ))}
//               </ScrollView>
//             </View>
//           </View>
//         )}
//       </Animated.View>
//     </SafeAreaView>
//     // </GradientBackground>
//   );
// }

///////////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   ScrollView,
//   Image,
//   StyleSheet,
//   Animated,
// } from 'react-native';
// import {useAuth0} from 'react-native-auth0';
// import {Calendar, DateObject} from 'react-native-calendars';
// import {useAppTheme} from '../context/ThemeContext';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// type WardrobeItem = {
//   id: string;
//   name: string;
//   image: string;
//   mainCategory: string;
//   subCategory: string;
//   material: string;
//   fit: string;
//   color: string;
//   size: string;
//   notes: string;
// };

// type SavedOutfit = {
//   id: string;
//   name?: string;
//   top: WardrobeItem | null;
//   bottom: WardrobeItem | null;
//   shoes: WardrobeItem | null;
//   createdAt: string;
//   tags?: string[];
//   notes?: string;
//   rating?: number;
//   favorited?: boolean;
//   plannedDate?: string;
//   type?: 'custom' | 'ai';
// };

// // ───────── helpers ─────────
// const getLocalDateKey = (iso: string) => {
//   const d = new Date(iso);
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, '0');
//   const day = String(d.getDate()).padStart(2, '0');
//   return `${y}-${m}-${day}`;
// };

// const formatLocalTime = (iso?: string) => {
//   if (!iso) return '';
//   return new Date(iso).toLocaleTimeString(undefined, {
//     hour: 'numeric',
//     minute: '2-digit',
//     timeZoneName: 'short',
//   });
// };

// const h = (type: string) =>
//   ReactNativeHapticFeedback.trigger(type, {
//     enableVibrateFallback: true,
//     ignoreAndroidSystemSettings: false,
//   });

// export default function OutfitPlannerScreen() {
//   const {user} = useAuth0();
//   const userId = useUUID() || user?.sub || '';
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const colors = theme.colors;

//   // ✨ Fade animation for content
//   const fadeAnim = useRef(new Animated.Value(0)).current;

//   useEffect(() => {
//     Animated.timing(fadeAnim, {
//       toValue: 1,
//       duration: 650,
//       useNativeDriver: true,
//     }).start();
//   }, []);

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     card: {
//       borderRadius: 16,
//       padding: 14,
//       marginBottom: 6,
//       backgroundColor: theme.colors.surface3 ?? theme.colors.surface3,
//       borderWidth: StyleSheet.hairlineWidth,
//       borderColor: theme.colors.input2 ?? theme.colors.surfaceBorder,
//     },
//     name: {color: theme.colors.foreground, fontSize: 16, fontWeight: '600'},
//     time: {color: theme.colors.foreground2, marginTop: 4, fontSize: 13},
//     row: {flexDirection: 'row', marginTop: 10},
//     thumb: {
//       width: 68,
//       height: 68,
//       borderRadius: 12,
//       marginRight: 8,
//       borderWidth: theme.borderWidth?.md ?? StyleSheet.hairlineWidth,
//       borderColor: theme.colors.surfaceBorder,
//       backgroundColor: theme.colors.surface,
//     },
//     notes: {
//       fontStyle: 'italic',
//       color: theme.colors.foreground2,
//       marginTop: 8,
//       lineHeight: 18,
//     },
//     rating: {color: '#FFD700', marginTop: 6, fontSize: 16},
//   });

//   const [scheduledOutfits, setScheduledOutfits] = useState<SavedOutfit[]>([]);
//   const [selectedDate, setSelectedDate] = useState<string | null>(null);
//   const [modalVisible, setModalVisible] = useState(false);

//   const normalizeImageUrl = (url: string | undefined | null): string => {
//     if (!url) return '';
//     return url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
//   };

//   useEffect(() => {
//     if (!userId) return;

//     const fetchData = async () => {
//       try {
//         const [aiRes, customRes, scheduledRes] = await Promise.all([
//           fetch(`${API_BASE_URL}/outfit/suggestions/${userId}`),
//           fetch(`${API_BASE_URL}/outfit/custom/${userId}`),
//           fetch(`${API_BASE_URL}/scheduled-outfits/${userId}`),
//         ]);

//         if (!aiRes.ok || !customRes.ok || !scheduledRes.ok) {
//           throw new Error('Failed to fetch outfit schedule data');
//         }

//         const [aiData, customData, scheduledData] = await Promise.all([
//           aiRes.json(),
//           customRes.json(),
//           scheduledRes.json(),
//         ]);

//         const scheduleMap: Record<string, string> = {};
//         for (const s of scheduledData) {
//           if (s.ai_outfit_id) {
//             scheduleMap[s.ai_outfit_id] = s.scheduled_for;
//           } else if (s.custom_outfit_id) {
//             scheduleMap[s.custom_outfit_id] = s.scheduled_for;
//           }
//         }

//         const normalize = (o: any, isCustom: boolean): SavedOutfit | null => {
//           const id = o.id;
//           const plannedDate = scheduleMap[id];
//           if (!plannedDate) return null;

//           return {
//             id,
//             name: o.name || '',
//             top: o.top
//               ? {
//                   id: o.top.id,
//                   name: o.top.name,
//                   image: normalizeImageUrl(o.top.image || o.top.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             bottom: o.bottom
//               ? {
//                   id: o.bottom.id,
//                   name: o.bottom.name,
//                   image: normalizeImageUrl(
//                     o.bottom.image || o.bottom.image_url,
//                   ),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             shoes: o.shoes
//               ? {
//                   id: o.shoes.id,
//                   name: o.shoes.name,
//                   image: normalizeImageUrl(o.shoes.image || o.shoes.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             createdAt: o.created_at
//               ? new Date(o.created_at).toISOString()
//               : new Date().toISOString(),
//             tags: o.tags || [],
//             notes: o.notes || '',
//             rating: o.rating ?? undefined,
//             favorited: false,
//             plannedDate,
//             type: isCustom ? 'custom' : 'ai',
//           };
//         };

//         const outfits = [
//           ...aiData.map(o => normalize(o, false)),
//           ...customData.map(o => normalize(o, true)),
//         ].filter(Boolean) as SavedOutfit[];

//         setScheduledOutfits(outfits);
//       } catch (err) {
//         console.error('❌ Failed to load calendar outfits:', err);
//       }
//     };

//     fetchData();
//   }, [userId]);

//   const markedDates = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = {dots: []};
//     acc[date].dots.push({
//       color: outfit.type === 'ai' ? '#405de6' : '#00c6ae',
//     });
//     return acc;
//   }, {} as Record<string, any>);

//   const outfitsByDate = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = [];
//     acc[date].push(outfit);
//     return acc;
//   }, {} as Record<string, SavedOutfit[]>);

//   const handleDayPress = (day: DateObject) => {
//     setSelectedDate(day.dateString);
//     setModalVisible(true);
//     h('selection');
//   };

//   return (
//     <View
//       style={[
//         globalStyles.container,
//         {backgroundColor: theme.colors.background},
//       ]}>
//       <Text style={[globalStyles.header, {marginBottom: 8}]}>
//         Planned Outfits
//       </Text>

//       <Animated.View style={{opacity: fadeAnim, flex: 1}}>
//         {/* 📅 Calendar with bottom border */}
//         <View
//           style={{
//             borderBottomWidth: 1,
//             borderBottomColor: theme.colors.surfaceBorder,
//           }}>
//           <Calendar
//             onDayPress={handleDayPress}
//             markedDates={{
//               ...markedDates,
//               ...(selectedDate
//                 ? {
//                     [selectedDate]: {
//                       selected: true,
//                       selectedColor: theme.colors.primary,
//                     },
//                   }
//                 : {}),
//             }}
//             markingType="multi-dot"
//             theme={{
//               calendarBackground: theme.colors.background,
//               textSectionTitleColor: theme.colors.foreground2,
//               dayTextColor: theme.colors.foreground,
//               todayTextColor: theme.colors.primary,
//               selectedDayBackgroundColor: theme.colors.primary,
//               selectedDayTextColor: '#fff',
//               arrowColor: theme.colors.primary,
//               monthTextColor: theme.colors.primary,
//               textMonthFontWeight: 'bold',
//               textDayFontSize: 16,
//               textMonthFontSize: 18,
//               textDayHeaderFontSize: 14,
//               dotColor: theme.colors.primary,
//               selectedDotColor: '#fff',
//               disabledArrowColor: '#444',
//             }}
//           />
//         </View>

//         {/* 🪄 Directly below calendar */}
//         {modalVisible && (
//           <View
//             style={{
//               flex: 1,
//               marginTop: 0,
//               paddingTop: 2,
//               paddingHorizontal: 16,
//             }}>
//             <View
//               style={{
//                 flexDirection: 'row',
//                 justifyContent: 'space-between',
//                 alignItems: 'center',
//               }}></View>

//             <ScrollView
//               showsVerticalScrollIndicator={false}
//               contentContainerStyle={{
//                 paddingBottom: 40,
//                 paddingTop: 4,
//               }}>
//               {(outfitsByDate[selectedDate!] || []).map((o, index) => (
//                 <View key={index} style={styles.card}>
//                   <Text style={styles.name}>
//                     {o.name?.trim() || 'Unnamed Outfit'}
//                   </Text>
//                   <Text style={styles.time}>
//                     🕒 {formatLocalTime(o.plannedDate)}
//                   </Text>

//                   <View style={styles.row}>
//                     {[o.top, o.bottom, o.shoes].map(item =>
//                       item?.image ? (
//                         <Image
//                           key={item.id}
//                           source={{uri: item.image}}
//                           style={styles.thumb}
//                           resizeMode="cover"
//                         />
//                       ) : null,
//                     )}
//                   </View>

//                   {o.notes ? <Text style={styles.notes}>{o.notes}</Text> : null}

//                   {typeof o.rating === 'number' && (
//                     <Text style={styles.rating}>
//                       {'⭐'.repeat(o.rating)} {'☆'.repeat(5 - o.rating)}
//                     </Text>
//                   )}
//                 </View>
//               ))}
//             </ScrollView>
//           </View>
//         )}
//       </Animated.View>
//     </View>
//   );
// }

//////////////////

// import React, {useEffect, useState, useRef} from 'react';
// import {
//   View,
//   Text,
//   ScrollView,
//   Image,
//   StyleSheet,
//   Animated,
// } from 'react-native';
// import {useAuth0} from 'react-native-auth0';
// import {Calendar, DateObject} from 'react-native-calendars';
// import {useAppTheme} from '../context/ThemeContext';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// type WardrobeItem = {
//   id: string;
//   name: string;
//   image: string;
//   mainCategory: string;
//   subCategory: string;
//   material: string;
//   fit: string;
//   color: string;
//   size: string;
//   notes: string;
// };

// type SavedOutfit = {
//   id: string;
//   name?: string;
//   top: WardrobeItem | null;
//   bottom: WardrobeItem | null;
//   shoes: WardrobeItem | null;
//   createdAt: string;
//   tags?: string[];
//   notes?: string;
//   rating?: number;
//   favorited?: boolean;
//   plannedDate?: string;
//   type?: 'custom' | 'ai';
// };

// // ───────── helpers ─────────
// const getLocalDateKey = (iso: string) => {
//   const d = new Date(iso);
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, '0');
//   const day = String(d.getDate()).padStart(2, '0');
//   return `${y}-${m}-${day}`;
// };

// const formatLocalTime = (iso?: string) => {
//   if (!iso) return '';
//   return new Date(iso).toLocaleTimeString(undefined, {
//     hour: 'numeric',
//     minute: '2-digit',
//     timeZoneName: 'short',
//   });
// };

// const h = (type: string) =>
//   ReactNativeHapticFeedback.trigger(type, {
//     enableVibrateFallback: true,
//     ignoreAndroidSystemSettings: false,
//   });

// export default function OutfitPlannerScreen() {
//   const {user} = useAuth0();
//   const userId = useUUID() || user?.sub || '';
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const colors = theme.colors;

//   // ✨ Fade animation for content
//   const fadeAnim = useRef(new Animated.Value(0)).current;

//   useEffect(() => {
//     Animated.timing(fadeAnim, {
//       toValue: 1,
//       duration: 650,
//       useNativeDriver: true,
//     }).start();
//   }, []);

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     chipGroup: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       marginTop: 4,
//     },
//     input: {
//       borderWidth: 1,
//       borderColor: colors.surface,
//       borderRadius: 8,
//       paddingVertical: 8,
//       paddingHorizontal: 12,
//       fontSize: 16,
//       color: colors.foreground,
//     },
//     chipRow: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 4},
//     card: {
//       borderRadius: 16,
//       padding: 14,
//       marginBottom: 12,
//       backgroundColor: theme.colors.surface3 ?? theme.colors.surface3,
//       borderWidth: StyleSheet.hairlineWidth,
//       borderColor: theme.colors.input2 ?? theme.colors.surfaceBorder,
//     },
//     name: {color: theme.colors.foreground, fontSize: 16, fontWeight: '600'},
//     time: {color: theme.colors.foreground2, marginTop: 4, fontSize: 13},
//     row: {flexDirection: 'row', marginTop: 10},
//     thumb: {
//       width: 68,
//       height: 68,
//       borderRadius: 12,
//       marginRight: 8,
//       borderWidth: theme.borderWidth?.md ?? StyleSheet.hairlineWidth,
//       borderColor: theme.colors.surfaceBorder,
//       backgroundColor: theme.colors.surface,
//     },
//     notes: {
//       fontStyle: 'italic',
//       color: theme.colors.foreground2,
//       marginTop: 8,
//       lineHeight: 18,
//     },
//     rating: {color: '#FFD700', marginTop: 6, fontSize: 16},
//   });

//   const [scheduledOutfits, setScheduledOutfits] = useState<SavedOutfit[]>([]);
//   const [selectedDate, setSelectedDate] = useState<string | null>(null);
//   const [modalVisible, setModalVisible] = useState(false);

//   const normalizeImageUrl = (url: string | undefined | null): string => {
//     if (!url) return '';
//     return url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
//   };

//   useEffect(() => {
//     if (!userId) return;

//     const fetchData = async () => {
//       try {
//         const [aiRes, customRes, scheduledRes] = await Promise.all([
//           fetch(`${API_BASE_URL}/outfit/suggestions/${userId}`),
//           fetch(`${API_BASE_URL}/outfit/custom/${userId}`),
//           fetch(`${API_BASE_URL}/scheduled-outfits/${userId}`),
//         ]);

//         if (!aiRes.ok || !customRes.ok || !scheduledRes.ok) {
//           throw new Error('Failed to fetch outfit schedule data');
//         }

//         const [aiData, customData, scheduledData] = await Promise.all([
//           aiRes.json(),
//           customRes.json(),
//           scheduledRes.json(),
//         ]);

//         const scheduleMap: Record<string, string> = {};
//         for (const s of scheduledData) {
//           if (s.ai_outfit_id) {
//             scheduleMap[s.ai_outfit_id] = s.scheduled_for;
//           } else if (s.custom_outfit_id) {
//             scheduleMap[s.custom_outfit_id] = s.scheduled_for;
//           }
//         }

//         const normalize = (o: any, isCustom: boolean): SavedOutfit | null => {
//           const id = o.id;
//           const plannedDate = scheduleMap[id];
//           if (!plannedDate) return null;

//           return {
//             id,
//             name: o.name || '',
//             top: o.top
//               ? {
//                   id: o.top.id,
//                   name: o.top.name,
//                   image: normalizeImageUrl(o.top.image || o.top.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             bottom: o.bottom
//               ? {
//                   id: o.bottom.id,
//                   name: o.bottom.name,
//                   image: normalizeImageUrl(
//                     o.bottom.image || o.bottom.image_url,
//                   ),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             shoes: o.shoes
//               ? {
//                   id: o.shoes.id,
//                   name: o.shoes.name,
//                   image: normalizeImageUrl(o.shoes.image || o.shoes.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             createdAt: o.created_at
//               ? new Date(o.created_at).toISOString()
//               : new Date().toISOString(),
//             tags: o.tags || [],
//             notes: o.notes || '',
//             rating: o.rating ?? undefined,
//             favorited: false,
//             plannedDate,
//             type: isCustom ? 'custom' : 'ai',
//           };
//         };

//         const outfits = [
//           ...aiData.map(o => normalize(o, false)),
//           ...customData.map(o => normalize(o, true)),
//         ].filter(Boolean) as SavedOutfit[];

//         setScheduledOutfits(outfits);
//       } catch (err) {
//         console.error('❌ Failed to load calendar outfits:', err);
//       }
//     };

//     fetchData();
//   }, [userId]);

//   const markedDates = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = {dots: []};
//     acc[date].dots.push({
//       color: outfit.type === 'ai' ? '#405de6' : '#00c6ae',
//     });
//     return acc;
//   }, {} as Record<string, any>);

//   const outfitsByDate = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = [];
//     acc[date].push(outfit);
//     return acc;
//   }, {} as Record<string, SavedOutfit[]>);

//   const handleDayPress = (day: DateObject) => {
//     setSelectedDate(day.dateString);
//     setModalVisible(true);
//     h('selection');
//   };

//   return (
//     <View
//       style={[
//         globalStyles.container,
//         {backgroundColor: theme.colors.background},
//       ]}>
//       {/* 📌 Static header (does not animate) */}
//       <Text style={[globalStyles.header, {marginBottom: 8}]}>
//         Planned Outfits
//       </Text>

//       {/* ✨ Fade-in content */}
//       <Animated.View style={{opacity: fadeAnim}}>
//         <View style={globalStyles.section}>
//           <Calendar
//             onDayPress={handleDayPress}
//             markedDates={{
//               ...markedDates,
//               ...(selectedDate
//                 ? {
//                     [selectedDate]: {
//                       selected: true,
//                       selectedColor: theme.colors.primary,
//                     },
//                   }
//                 : {}),
//             }}
//             markingType="multi-dot"
//             theme={{
//               calendarBackground: theme.colors.background,
//               textSectionTitleColor: theme.colors.foreground2,
//               dayTextColor: theme.colors.foreground,
//               todayTextColor: theme.colors.primary,
//               selectedDayBackgroundColor: theme.colors.primary,
//               selectedDayTextColor: '#fff',
//               arrowColor: theme.colors.primary,
//               monthTextColor: theme.colors.primary,
//               textMonthFontWeight: 'bold',
//               textDayFontSize: 16,
//               textMonthFontSize: 18,
//               textDayHeaderFontSize: 14,
//               dotColor: theme.colors.primary,
//               selectedDotColor: '#fff',
//               disabledArrowColor: '#444',
//             }}
//           />

//           {modalVisible && (
//             <View
//               style={{
//                 position: 'absolute',
//                 top: 300,
//                 left: 0,
//                 right: 0,
//                 alignItems: 'center',
//                 paddingVertical: 20,
//               }}>
//               <View
//                 style={{
//                   position: 'relative',
//                   backgroundColor: theme.colors.surface,
//                   borderRadius: 20,
//                   padding: 20,
//                   maxHeight: '65%',
//                   width: 'auto',
//                   minWidth: 400,
//                   alignSelf: 'center',
//                 }}>
//                 <AppleTouchFeedback
//                   onPress={() => setModalVisible(false)}
//                   hapticStyle="impactMedium"
//                   hitSlop={{top: 12, right: 12, bottom: 12, left: 12}}
//                   style={{
//                     position: 'absolute',
//                     top: 4,
//                     right: 12,
//                     backgroundColor: theme.colors.secondary,
//                     paddingHorizontal: 12,
//                     paddingVertical: 6,
//                     borderRadius: 20,
//                     zIndex: 100,
//                     elevation: 95,
//                   }}>
//                   <Text
//                     style={{color: 'white', fontWeight: '700', fontSize: 14}}>
//                     ✕
//                   </Text>
//                 </AppleTouchFeedback>
//                 <Text
//                   style={{
//                     fontSize: 18,
//                     fontWeight: '600',
//                     color: theme.colors.foreground,
//                     marginBottom: 12,
//                   }}>
//                   Outfits on {selectedDate}
//                 </Text>

//                 <ScrollView
//                   contentContainerStyle={{
//                     paddingBottom: 1000,
//                   }}>
//                   {(outfitsByDate[selectedDate!] || []).map((o, index) => (
//                     <View key={index} style={styles.card}>
//                       <Text style={styles.name}>
//                         {o.name?.trim() || 'Unnamed Outfit'}
//                       </Text>

//                       <Text style={styles.time}>
//                         🕒 {formatLocalTime(o.plannedDate)}
//                       </Text>

//                       <View style={styles.row}>
//                         {[o.top, o.bottom, o.shoes].map(item =>
//                           item?.image ? (
//                             <Image
//                               key={item.id}
//                               source={{uri: item.image}}
//                               style={styles.thumb}
//                               resizeMode="cover"
//                             />
//                           ) : null,
//                         )}
//                       </View>

//                       {o.notes ? (
//                         <Text style={styles.notes}>{o.notes}</Text>
//                       ) : null}

//                       {typeof o.rating === 'number' && (
//                         <Text style={styles.rating}>
//                           {'⭐'.repeat(o.rating)} {'☆'.repeat(5 - o.rating)}
//                         </Text>
//                       )}
//                     </View>
//                   ))}
//                 </ScrollView>
//               </View>
//             </View>
//           )}
//         </View>
//       </Animated.View>
//     </View>
//   );
// }

/////////////////////////

// import React, {useEffect, useState} from 'react';
// import {View, Text, ScrollView, Image, StyleSheet} from 'react-native';
// import {useAuth0} from 'react-native-auth0';
// import {Calendar, DateObject} from 'react-native-calendars';
// import {useAppTheme} from '../context/ThemeContext';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// type WardrobeItem = {
//   id: string;
//   name: string;
//   image: string;
//   mainCategory: string;
//   subCategory: string;
//   material: string;
//   fit: string;
//   color: string;
//   size: string;
//   notes: string;
// };

// type SavedOutfit = {
//   id: string;
//   name?: string;
//   top: WardrobeItem | null;
//   bottom: WardrobeItem | null;
//   shoes: WardrobeItem | null;
//   createdAt: string;
//   tags?: string[];
//   notes?: string;
//   rating?: number;
//   favorited?: boolean;
//   plannedDate?: string;
//   type?: 'custom' | 'ai';
// };

// // ───────── helpers (local date key + local time formatter) ─────────
// const getLocalDateKey = (iso: string) => {
//   const d = new Date(iso);
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, '0');
//   const day = String(d.getDate()).padStart(2, '0');
//   return `${y}-${m}-${day}`; // YYYY-MM-DD in *local* time
// };

// const formatLocalTime = (iso?: string) => {
//   if (!iso) return '';
//   return new Date(iso).toLocaleTimeString(undefined, {
//     hour: 'numeric',
//     minute: '2-digit',
//     timeZoneName: 'short',
//   });
// };

// const h = (type: string) =>
//   ReactNativeHapticFeedback.trigger(type, {
//     enableVibrateFallback: true,
//     ignoreAndroidSystemSettings: false,
//   });

// export default function OutfitPlannerScreen() {
//   const {user} = useAuth0();
//   const userId = useUUID() || user?.sub || '';
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const colors = theme.colors;

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     chipGroup: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       marginTop: 4,
//     },
//     input: {
//       borderWidth: 1,
//       borderColor: colors.surface,
//       borderRadius: 8,
//       paddingVertical: 8,
//       paddingHorizontal: 12,
//       fontSize: 16,
//       color: colors.foreground,
//     },
//     chipRow: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 4},

//     // ▼▼ Card styles copied to match your other screen ▼▼
//     card: {
//       borderRadius: 16,
//       padding: 14,
//       marginBottom: 12,
//       backgroundColor: theme.colors.surface3 ?? theme.colors.surface3,
//       borderWidth: StyleSheet.hairlineWidth,
//       borderColor: theme.colors.input2 ?? theme.colors.surfaceBorder,
//     },
//     name: {color: theme.colors.foreground, fontSize: 16, fontWeight: '600'},
//     time: {color: theme.colors.foreground2, marginTop: 4, fontSize: 13},
//     row: {flexDirection: 'row', marginTop: 10},
//     thumb: {
//       width: 68,
//       height: 68,
//       borderRadius: 12,
//       marginRight: 8,
//       borderWidth: theme.borderWidth?.md ?? StyleSheet.hairlineWidth,
//       borderColor: theme.colors.surfaceBorder,
//       backgroundColor: theme.colors.surface,
//     },
//     notes: {
//       fontStyle: 'italic',
//       color: theme.colors.foreground2,
//       marginTop: 8,
//       lineHeight: 18,
//     },
//     rating: {color: '#FFD700', marginTop: 6, fontSize: 16},
//     // ▲▲ Only used for the modal cards ▲▲
//   });

//   const [scheduledOutfits, setScheduledOutfits] = useState<SavedOutfit[]>([]);
//   const [selectedDate, setSelectedDate] = useState<string | null>(null);
//   const [modalVisible, setModalVisible] = useState(false);

//   const normalizeImageUrl = (url: string | undefined | null): string => {
//     if (!url) return '';
//     return url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
//   };

//   useEffect(() => {
//     if (!userId) return;

//     const fetchData = async () => {
//       try {
//         const [aiRes, customRes, scheduledRes] = await Promise.all([
//           fetch(`${API_BASE_URL}/outfit/suggestions/${userId}`),
//           fetch(`${API_BASE_URL}/outfit/custom/${userId}`),
//           fetch(`${API_BASE_URL}/scheduled-outfits/${userId}`),
//         ]);

//         if (!aiRes.ok || !customRes.ok || !scheduledRes.ok) {
//           throw new Error('Failed to fetch outfit schedule data');
//         }

//         const [aiData, customData, scheduledData] = await Promise.all([
//           aiRes.json(),
//           customRes.json(),
//           scheduledRes.json(),
//         ]);

//         const scheduleMap: Record<string, string> = {};
//         for (const s of scheduledData) {
//           if (s.ai_outfit_id) {
//             scheduleMap[s.ai_outfit_id] = s.scheduled_for;
//           } else if (s.custom_outfit_id) {
//             scheduleMap[s.custom_outfit_id] = s.scheduled_for;
//           }
//         }

//         const normalize = (o: any, isCustom: boolean): SavedOutfit | null => {
//           const id = o.id;
//           const plannedDate = scheduleMap[id];
//           if (!plannedDate) return null;

//           return {
//             id,
//             name: o.name || '',
//             top: o.top
//               ? {
//                   id: o.top.id,
//                   name: o.top.name,
//                   image: normalizeImageUrl(o.top.image || o.top.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             bottom: o.bottom
//               ? {
//                   id: o.bottom.id,
//                   name: o.bottom.name,
//                   image: normalizeImageUrl(
//                     o.bottom.image || o.bottom.image_url,
//                   ),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             shoes: o.shoes
//               ? {
//                   id: o.shoes.id,
//                   name: o.shoes.name,
//                   image: normalizeImageUrl(o.shoes.image || o.shoes.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             createdAt: o.created_at
//               ? new Date(o.created_at).toISOString()
//               : new Date().toISOString(),
//             tags: o.tags || [],
//             notes: o.notes || '',
//             rating: o.rating ?? undefined,
//             favorited: false,
//             plannedDate,
//             type: isCustom ? 'custom' : 'ai',
//           };
//         };

//         const outfits = [
//           ...aiData.map(o => normalize(o, false)),
//           ...customData.map(o => normalize(o, true)),
//         ].filter(Boolean) as SavedOutfit[];

//         setScheduledOutfits(outfits);
//       } catch (err) {
//         console.error('❌ Failed to load calendar outfits:', err);
//       }
//     };

//     fetchData();
//   }, [userId]);

//   // Use *local* date keys so dots/cards line up with the device’s local day.
//   const markedDates = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = {dots: []};
//     acc[date].dots.push({
//       color: outfit.type === 'ai' ? '#405de6' : '#00c6ae',
//     });
//     return acc;
//   }, {} as Record<string, any>);

//   const outfitsByDate = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = [];
//     acc[date].push(outfit);
//     return acc;
//   }, {} as Record<string, SavedOutfit[]>);

//   const handleDayPress = (day: DateObject) => {
//     setSelectedDate(day.dateString); // YYYY-MM-DD local from Calendar
//     setModalVisible(true);
//     h('selection'); // subtle feedback on day select
//   };

//   return (
//     <View
//       style={[
//         globalStyles.container,
//         {backgroundColor: theme.colors.background},
//       ]}>
//       <Text style={[globalStyles.header, {marginBottom: 8}]}>
//         Planned Outfits
//       </Text>

//       <View style={globalStyles.section}>
//         <Calendar
//           onDayPress={handleDayPress}
//           markedDates={{
//             ...markedDates,
//             ...(selectedDate
//               ? {
//                   [selectedDate]: {
//                     selected: true,
//                     selectedColor: theme.colors.primary,
//                   },
//                 }
//               : {}),
//           }}
//           markingType="multi-dot"
//           theme={{
//             calendarBackground: theme.colors.background,
//             textSectionTitleColor: theme.colors.foreground2,
//             dayTextColor: theme.colors.foreground,
//             todayTextColor: theme.colors.primary,
//             selectedDayBackgroundColor: theme.colors.primary,
//             selectedDayTextColor: '#fff',
//             arrowColor: theme.colors.primary,
//             monthTextColor: theme.colors.primary,
//             textMonthFontWeight: 'bold',
//             textDayFontSize: 16,
//             textMonthFontSize: 18,
//             textDayHeaderFontSize: 14,
//             dotColor: theme.colors.primary,
//             selectedDotColor: '#fff',
//             disabledArrowColor: '#444',
//           }}
//         />

//         {modalVisible && (
//           <View
//             style={{
//               position: 'absolute',
//               top: 300,
//               left: 0,
//               right: 0,
//               alignItems: 'center',
//               // backgroundColor: 'rgba(0,0,0,0.35)',
//               paddingVertical: 20,
//             }}>
//             <View
//               style={{
//                 position: 'relative',
//                 backgroundColor: theme.colors.surface,
//                 borderRadius: 20,
//                 padding: 20,
//                 maxHeight: '65%',
//                 width: 'auto',
//                 minWidth: 400,
//                 alignSelf: 'center',
//               }}>
//               <AppleTouchFeedback
//                 onPress={() => setModalVisible(false)}
//                 hapticStyle="impactMedium"
//                 hitSlop={{top: 12, right: 12, bottom: 12, left: 12}}
//                 style={{
//                   position: 'absolute',
//                   top: 4,
//                   right: 12,
//                   backgroundColor: theme.colors.secondary,
//                   paddingHorizontal: 12,
//                   paddingVertical: 6,
//                   borderRadius: 20,
//                   zIndex: 100,
//                   elevation: 95,
//                 }}>
//                 <Text style={{color: 'white', fontWeight: '700', fontSize: 14}}>
//                   ✕
//                 </Text>
//               </AppleTouchFeedback>
//               <Text
//                 style={{
//                   fontSize: 18,
//                   fontWeight: '600',
//                   color: theme.colors.foreground,
//                   marginBottom: 12,
//                 }}>
//                 Outfits on {selectedDate}
//               </Text>

//               <ScrollView
//                 contentContainerStyle={{
//                   paddingBottom: 1000, // 👈 add more space so the last card clears the bottom nav
//                 }}>
//                 {(outfitsByDate[selectedDate!] || []).map((o, index) => (
//                   <View key={index} style={styles.card}>
//                     <Text style={styles.name}>
//                       {o.name?.trim() || 'Unnamed Outfit'}
//                     </Text>

//                     {/* 🕒 show scheduled time */}
//                     <Text style={styles.time}>
//                       🕒 {formatLocalTime(o.plannedDate)}
//                     </Text>

//                     <View style={styles.row}>
//                       {[o.top, o.bottom, o.shoes].map(item =>
//                         item?.image ? (
//                           <Image
//                             key={item.id}
//                             source={{uri: item.image}}
//                             style={styles.thumb}
//                             resizeMode="cover"
//                           />
//                         ) : null,
//                       )}
//                     </View>

//                     {o.notes ? (
//                       <Text style={styles.notes}>{o.notes}</Text>
//                     ) : null}

//                     {typeof o.rating === 'number' && (
//                       <Text style={styles.rating}>
//                         {'⭐'.repeat(o.rating)} {'☆'.repeat(5 - o.rating)}
//                       </Text>
//                     )}
//                   </View>
//                 ))}
//               </ScrollView>
//             </View>
//           </View>
//         )}
//       </View>
//     </View>
//   );
// }

//////////////////

// import React, {useEffect, useState} from 'react';
// import {View, Text, ScrollView, Image, StyleSheet} from 'react-native';
// import {useAuth0} from 'react-native-auth0';
// import {Calendar, DateObject} from 'react-native-calendars';
// import {useAppTheme} from '../context/ThemeContext';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {useGlobalStyles} from '../styles/useGlobalStyles';
// import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

// type WardrobeItem = {
//   id: string;
//   name: string;
//   image: string;
//   mainCategory: string;
//   subCategory: string;
//   material: string;
//   fit: string;
//   color: string;
//   size: string;
//   notes: string;
// };

// type SavedOutfit = {
//   id: string;
//   name?: string;
//   top: WardrobeItem | null;
//   bottom: WardrobeItem | null;
//   shoes: WardrobeItem | null;
//   createdAt: string;
//   tags?: string[];
//   notes?: string;
//   rating?: number;
//   favorited?: boolean;
//   plannedDate?: string;
//   type?: 'custom' | 'ai';
// };

// // ───────── helpers (local date key + local time formatter) ─────────
// const getLocalDateKey = (iso: string) => {
//   const d = new Date(iso);
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, '0');
//   const day = String(d.getDate()).padStart(2, '0');
//   return `${y}-${m}-${day}`; // YYYY-MM-DD in *local* time
// };

// const formatLocalTime = (iso?: string) => {
//   if (!iso) return '';
//   return new Date(iso).toLocaleTimeString(undefined, {
//     hour: 'numeric',
//     minute: '2-digit',
//     timeZoneName: 'short',
//   });
// };

// const h = (type: string) =>
//   ReactNativeHapticFeedback.trigger(type, {
//     enableVibrateFallback: true,
//     ignoreAndroidSystemSettings: false,
//   });

// export default function OutfitPlannerScreen() {
//   const {user} = useAuth0();
//   const userId = useUUID() || user?.sub || '';
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const colors = theme.colors;

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     chipGroup: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       marginTop: 4,
//     },
//     input: {
//       borderWidth: 1,
//       borderColor: colors.surface,
//       borderRadius: 8,
//       paddingVertical: 8,
//       paddingHorizontal: 12,
//       fontSize: 16,
//       color: colors.foreground,
//     },
//     chipRow: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 4},
//   });

//   const [scheduledOutfits, setScheduledOutfits] = useState<SavedOutfit[]>([]);
//   const [selectedDate, setSelectedDate] = useState<string | null>(null);
//   const [modalVisible, setModalVisible] = useState(false);

//   const normalizeImageUrl = (url: string | undefined | null): string => {
//     if (!url) return '';
//     return url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
//   };

//   useEffect(() => {
//     if (!userId) return;

//     const fetchData = async () => {
//       try {
//         const [aiRes, customRes, scheduledRes] = await Promise.all([
//           fetch(`${API_BASE_URL}/outfit/suggestions/${userId}`),
//           fetch(`${API_BASE_URL}/outfit/custom/${userId}`),
//           fetch(`${API_BASE_URL}/scheduled-outfits/${userId}`),
//         ]);

//         if (!aiRes.ok || !customRes.ok || !scheduledRes.ok) {
//           throw new Error('Failed to fetch outfit schedule data');
//         }

//         const [aiData, customData, scheduledData] = await Promise.all([
//           aiRes.json(),
//           customRes.json(),
//           scheduledRes.json(),
//         ]);

//         const scheduleMap: Record<string, string> = {};
//         for (const s of scheduledData) {
//           if (s.ai_outfit_id) {
//             scheduleMap[s.ai_outfit_id] = s.scheduled_for;
//           } else if (s.custom_outfit_id) {
//             scheduleMap[s.custom_outfit_id] = s.scheduled_for;
//           }
//         }

//         const normalize = (o: any, isCustom: boolean): SavedOutfit | null => {
//           const id = o.id;
//           const plannedDate = scheduleMap[id];
//           if (!plannedDate) return null;

//           return {
//             id,
//             name: o.name || '',
//             top: o.top
//               ? {
//                   id: o.top.id,
//                   name: o.top.name,
//                   image: normalizeImageUrl(o.top.image || o.top.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             bottom: o.bottom
//               ? {
//                   id: o.bottom.id,
//                   name: o.bottom.name,
//                   image: normalizeImageUrl(
//                     o.bottom.image || o.bottom.image_url,
//                   ),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             shoes: o.shoes
//               ? {
//                   id: o.shoes.id,
//                   name: o.shoes.name,
//                   image: normalizeImageUrl(o.shoes.image || o.shoes.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             createdAt: o.created_at
//               ? new Date(o.created_at).toISOString()
//               : new Date().toISOString(),
//             tags: o.tags || [],
//             notes: o.notes || '',
//             rating: o.rating ?? undefined,
//             favorited: false,
//             plannedDate,
//             type: isCustom ? 'custom' : 'ai',
//           };
//         };

//         const outfits = [
//           ...aiData.map(o => normalize(o, false)),
//           ...customData.map(o => normalize(o, true)),
//         ].filter(Boolean) as SavedOutfit[];

//         setScheduledOutfits(outfits);
//       } catch (err) {
//         console.error('❌ Failed to load calendar outfits:', err);
//       }
//     };

//     fetchData();
//   }, [userId]);

//   // Use *local* date keys so dots/cards line up with the device’s local day.
//   const markedDates = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = {dots: []};
//     acc[date].dots.push({
//       color: outfit.type === 'ai' ? '#405de6' : '#00c6ae',
//     });
//     return acc;
//   }, {} as Record<string, any>);

//   const outfitsByDate = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = [];
//     acc[date].push(outfit);
//     return acc;
//   }, {} as Record<string, SavedOutfit[]>);

//   const handleDayPress = (day: DateObject) => {
//     setSelectedDate(day.dateString); // YYYY-MM-DD local from Calendar
//     setModalVisible(true);
//     h('selection'); // subtle feedback on day select
//   };

//   return (
//     <View
//       style={[
//         globalStyles.container,
//         {backgroundColor: theme.colors.background},
//       ]}>
//       <Text style={[globalStyles.header, {marginBottom: 8}]}>
//         Planned Outfits
//       </Text>

//       <View style={globalStyles.section}>
//         <Calendar
//           onDayPress={handleDayPress}
//           markedDates={{
//             ...markedDates,
//             ...(selectedDate
//               ? {
//                   [selectedDate]: {
//                     selected: true,
//                     selectedColor: theme.colors.primary,
//                   },
//                 }
//               : {}),
//           }}
//           markingType="multi-dot"
//           theme={{
//             calendarBackground: theme.colors.background,
//             textSectionTitleColor: theme.colors.foreground2,
//             dayTextColor: theme.colors.foreground,
//             todayTextColor: theme.colors.primary,
//             selectedDayBackgroundColor: theme.colors.primary,
//             selectedDayTextColor: '#fff',
//             arrowColor: theme.colors.primary,
//             monthTextColor: theme.colors.primary,
//             textMonthFontWeight: 'bold',
//             textDayFontSize: 16,
//             textMonthFontSize: 18,
//             textDayHeaderFontSize: 14,
//             dotColor: theme.colors.primary,
//             selectedDotColor: '#fff',
//             disabledArrowColor: '#444',
//           }}
//         />

//         {modalVisible && (
//           <View
//             style={{
//               position: 'absolute',
//               top: 300,
//               left: 0,
//               right: 0,
//               alignItems: 'center',
//               backgroundColor: 'rgba(0,0,0,0.35)',
//               paddingVertical: 20,
//             }}>
//             <View
//               style={{
//                 position: 'relative',
//                 backgroundColor: theme.colors.surface,
//                 borderRadius: 20,
//                 padding: 20,
//                 maxHeight: '65%',
//                 width: 'auto',
//                 minWidth: 400,
//                 alignSelf: 'center',
//               }}>
//               <AppleTouchFeedback
//                 onPress={() => setModalVisible(false)}
//                 hapticStyle="impactMedium"
//                 hitSlop={{top: 12, right: 12, bottom: 12, left: 12}}
//                 style={{
//                   position: 'absolute',
//                   top: 4,
//                   right: 12,
//                   backgroundColor: theme.colors.secondary,
//                   paddingHorizontal: 12,
//                   paddingVertical: 6,
//                   borderRadius: 20,
//                   zIndex: 100,
//                   elevation: 95,
//                 }}>
//                 <Text style={{color: 'white', fontWeight: '700', fontSize: 14}}>
//                   ✕
//                 </Text>
//               </AppleTouchFeedback>
//               <Text
//                 style={{
//                   fontSize: 18,
//                   fontWeight: '600',
//                   color: theme.colors.foreground,
//                   marginBottom: 12,
//                 }}>
//                 Outfits on {selectedDate}
//               </Text>

//               <ScrollView>
//                 {(outfitsByDate[selectedDate!] || []).map((o, index) => (
//                   <View
//                     key={index}
//                     style={{
//                       marginBottom: 8,
//                       borderBottomColor: '#ddd',
//                       paddingBottom: 8,
//                       backgroundColor: '#141414ff',
//                       padding: 16,
//                       borderRadius: 15,
//                     }}>
//                     <Text
//                       style={{color: theme.colors.foreground, fontSize: 16}}>
//                       {o.name?.trim() || 'Unnamed Outfit'}
//                     </Text>

//                     {/* 🕒 show scheduled time */}
//                     <Text
//                       style={{color: theme.colors.foreground2, marginTop: 4}}>
//                       🕒 {formatLocalTime(o.plannedDate)}
//                     </Text>

//                     <View style={{flexDirection: 'row', marginTop: 8}}>
//                       {[o.top, o.bottom, o.shoes].map(item =>
//                         item?.image ? (
//                           <Image
//                             key={item.id}
//                             source={{uri: item.image}}
//                             style={{
//                               width: 60,
//                               height: 60,
//                               borderRadius: 8,
//                               marginRight: 8,
//                               marginBottom: 16,
//                             }}
//                           />
//                         ) : null,
//                       )}
//                     </View>

//                     {o.notes ? (
//                       <Text
//                         style={{
//                           fontStyle: 'italic',
//                           color: theme.colors.foreground2,
//                           marginTop: 6,
//                         }}>
//                         {o.notes}
//                       </Text>
//                     ) : null}

//                     {typeof o.rating === 'number' && (
//                       <Text style={{color: '#FFD700', marginTop: 4}}>
//                         {'⭐'.repeat(o.rating)} {'☆'.repeat(5 - o.rating)}
//                       </Text>
//                     )}
//                   </View>
//                 ))}
//               </ScrollView>
//             </View>
//           </View>
//         )}
//       </View>
//     </View>
//   );
// }

//////////////////////

// import React, {useEffect, useState} from 'react';
// import {View, Text, ScrollView, Image, StyleSheet} from 'react-native';
// import {useAuth0} from 'react-native-auth0';
// import {Calendar, DateObject} from 'react-native-calendars';
// import {useAppTheme} from '../context/ThemeContext';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {useGlobalStyles} from '../styles/useGlobalStyles';

// type WardrobeItem = {
//   id: string;
//   name: string;
//   image: string;
//   mainCategory: string;
//   subCategory: string;
//   material: string;
//   fit: string;
//   color: string;
//   size: string;
//   notes: string;
// };

// type SavedOutfit = {
//   id: string;
//   name?: string;
//   top: WardrobeItem | null;
//   bottom: WardrobeItem | null;
//   shoes: WardrobeItem | null;
//   createdAt: string;
//   tags?: string[];
//   notes?: string;
//   rating?: number;
//   favorited?: boolean;
//   plannedDate?: string;
//   type?: 'custom' | 'ai';
// };

// // ───────── helpers (local date key + local time formatter) ─────────
// const getLocalDateKey = (iso: string) => {
//   const d = new Date(iso);
//   const y = d.getFullYear();
//   const m = String(d.getMonth() + 1).padStart(2, '0');
//   const day = String(d.getDate()).padStart(2, '0');
//   return `${y}-${m}-${day}`; // YYYY-MM-DD in *local* time
// };

// const formatLocalTime = (iso?: string) => {
//   if (!iso) return '';
//   return new Date(iso).toLocaleTimeString(undefined, {
//     hour: 'numeric',
//     minute: '2-digit',
//     timeZoneName: 'short',
//   });
// };

// export default function OutfitPlannerScreen() {
//   const {user} = useAuth0();
//   const userId = useUUID() || user?.sub || '';
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const colors = theme.colors;

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     chipGroup: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       marginTop: 4,
//     },
//     input: {
//       borderWidth: 1,
//       borderColor: colors.surface,
//       borderRadius: 8,
//       paddingVertical: 8,
//       paddingHorizontal: 12,
//       fontSize: 16,
//       color: colors.foreground,
//     },
//     chipRow: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 4},
//   });

//   const [scheduledOutfits, setScheduledOutfits] = useState<SavedOutfit[]>([]);
//   const [selectedDate, setSelectedDate] = useState<string | null>(null);
//   const [modalVisible, setModalVisible] = useState(false);

//   const normalizeImageUrl = (url: string | undefined | null): string => {
//     if (!url) return '';
//     return url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
//   };

//   useEffect(() => {
//     if (!userId) return;

//     const fetchData = async () => {
//       try {
//         const [aiRes, customRes, scheduledRes] = await Promise.all([
//           fetch(`${API_BASE_URL}/outfit/suggestions/${userId}`),
//           fetch(`${API_BASE_URL}/outfit/custom/${userId}`),
//           fetch(`${API_BASE_URL}/scheduled-outfits/${userId}`),
//         ]);

//         if (!aiRes.ok || !customRes.ok || !scheduledRes.ok) {
//           throw new Error('Failed to fetch outfit schedule data');
//         }

//         const [aiData, customData, scheduledData] = await Promise.all([
//           aiRes.json(),
//           customRes.json(),
//           scheduledRes.json(),
//         ]);

//         const scheduleMap: Record<string, string> = {};
//         for (const s of scheduledData) {
//           if (s.ai_outfit_id) {
//             scheduleMap[s.ai_outfit_id] = s.scheduled_for;
//           } else if (s.custom_outfit_id) {
//             scheduleMap[s.custom_outfit_id] = s.scheduled_for;
//           }
//         }

//         const normalize = (o: any, isCustom: boolean): SavedOutfit | null => {
//           const id = o.id;
//           const plannedDate = scheduleMap[id];
//           if (!plannedDate) return null;

//           return {
//             id,
//             name: o.name || '',
//             top: o.top
//               ? {
//                   id: o.top.id,
//                   name: o.top.name,
//                   image: normalizeImageUrl(o.top.image || o.top.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             bottom: o.bottom
//               ? {
//                   id: o.bottom.id,
//                   name: o.bottom.name,
//                   image: normalizeImageUrl(
//                     o.bottom.image || o.bottom.image_url,
//                   ),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             shoes: o.shoes
//               ? {
//                   id: o.shoes.id,
//                   name: o.shoes.name,
//                   image: normalizeImageUrl(o.shoes.image || o.shoes.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             createdAt: o.created_at
//               ? new Date(o.created_at).toISOString()
//               : new Date().toISOString(),
//             tags: o.tags || [],
//             notes: o.notes || '',
//             rating: o.rating ?? undefined,
//             favorited: false,
//             plannedDate,
//             type: isCustom ? 'custom' : 'ai',
//           };
//         };

//         const outfits = [
//           ...aiData.map(o => normalize(o, false)),
//           ...customData.map(o => normalize(o, true)),
//         ].filter(Boolean) as SavedOutfit[];

//         setScheduledOutfits(outfits);
//       } catch (err) {
//         console.error('❌ Failed to load calendar outfits:', err);
//       }
//     };

//     fetchData();
//   }, [userId]);

//   // Use *local* date keys so dots/cards line up with the device’s local day.
//   const markedDates = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = {dots: []};
//     acc[date].dots.push({
//       color: outfit.type === 'ai' ? '#405de6' : '#00c6ae',
//     });
//     return acc;
//   }, {} as Record<string, any>);

//   const outfitsByDate = scheduledOutfits.reduce((acc, outfit) => {
//     const date = getLocalDateKey(outfit.plannedDate!);
//     if (!acc[date]) acc[date] = [];
//     acc[date].push(outfit);
//     return acc;
//   }, {} as Record<string, SavedOutfit[]>);

//   const handleDayPress = (day: DateObject) => {
//     setSelectedDate(day.dateString); // YYYY-MM-DD local from Calendar
//     setModalVisible(true);
//   };

//   return (
//     <View
//       style={[
//         globalStyles.container,
//         {backgroundColor: theme.colors.background},
//       ]}>
//       <Text style={[globalStyles.header, {marginBottom: 8}]}>
//         Planned Outfits
//       </Text>

//       <View style={globalStyles.section}>
//         <Calendar
//           onDayPress={handleDayPress}
//           markedDates={{
//             ...markedDates,
//             ...(selectedDate
//               ? {
//                   [selectedDate]: {
//                     selected: true,
//                     selectedColor: theme.colors.primary,
//                   },
//                 }
//               : {}),
//           }}
//           markingType="multi-dot"
//           theme={{
//             calendarBackground: theme.colors.background,
//             textSectionTitleColor: theme.colors.foreground2,
//             dayTextColor: theme.colors.foreground,
//             todayTextColor: theme.colors.primary,
//             selectedDayBackgroundColor: theme.colors.primary,
//             selectedDayTextColor: '#fff',
//             arrowColor: theme.colors.primary,
//             monthTextColor: theme.colors.primary,
//             textMonthFontWeight: 'bold',
//             textDayFontSize: 16,
//             textMonthFontSize: 18,
//             textDayHeaderFontSize: 14,
//             dotColor: theme.colors.primary,
//             selectedDotColor: '#fff',
//             disabledArrowColor: '#444',
//           }}
//         />

//         {modalVisible && (
//           <View
//             style={{
//               position: 'absolute',
//               top: 300,
//               left: 0,
//               right: 0,
//               alignItems: 'center',
//               backgroundColor: 'rgba(0,0,0,0.35)',
//               paddingVertical: 20,
//             }}>
//             <View
//               style={{
//                 position: 'relative',
//                 backgroundColor: theme.colors.surface,
//                 borderRadius: 20,
//                 padding: 20,
//                 maxHeight: '65%',
//                 width: 'auto',
//                 minWidth: 400,
//                 alignSelf: 'center',
//               }}>
//               <AppleTouchFeedback
//                 onPress={() => setModalVisible(false)}
//                 hapticStyle="impactMedium"
//                 hitSlop={{top: 12, right: 12, bottom: 12, left: 12}} // ✅ bigger tap target
//                 style={{
//                   position: 'absolute',
//                   top: 4,
//                   right: 12,
//                   backgroundColor: theme.colors.secondary,
//                   paddingHorizontal: 12,
//                   paddingVertical: 6,
//                   borderRadius: 20,
//                   zIndex: 100,
//                   elevation: 95,
//                 }}>
//                 <Text style={{color: 'white', fontWeight: '700', fontSize: 14}}>
//                   ✕
//                 </Text>
//               </AppleTouchFeedback>
//               <Text
//                 style={{
//                   fontSize: 18,
//                   fontWeight: '600',
//                   color: theme.colors.foreground,
//                   marginBottom: 12,
//                 }}>
//                 Outfits on {selectedDate}
//               </Text>

//               <ScrollView>
//                 {(outfitsByDate[selectedDate!] || []).map((o, index) => (
//                   <View
//                     key={index}
//                     style={{
//                       marginBottom: 8,
//                       borderBottomColor: '#ddd',
//                       paddingBottom: 8,
//                       backgroundColor: '#141414ff',
//                       padding: 16,
//                       borderRadius: 15,
//                     }}>
//                     <Text
//                       style={{color: theme.colors.foreground, fontSize: 16}}>
//                       {o.name?.trim() || 'Unnamed Outfit'}
//                     </Text>

//                     {/* 🕒 show scheduled time */}
//                     <Text
//                       style={{color: theme.colors.foreground2, marginTop: 4}}>
//                       🕒 {formatLocalTime(o.plannedDate)}
//                     </Text>

//                     <View style={{flexDirection: 'row', marginTop: 8}}>
//                       {[o.top, o.bottom, o.shoes].map(item =>
//                         item?.image ? (
//                           <Image
//                             key={item.id}
//                             source={{uri: item.image}}
//                             style={{
//                               width: 60,
//                               height: 60,
//                               borderRadius: 8,
//                               marginRight: 8,
//                               marginBottom: 16,
//                             }}
//                           />
//                         ) : null,
//                       )}
//                     </View>

//                     {o.notes ? (
//                       <Text
//                         style={{
//                           fontStyle: 'italic',
//                           color: theme.colors.foreground2,
//                           marginTop: 6,
//                         }}>
//                         {o.notes}
//                       </Text>
//                     ) : null}

//                     {typeof o.rating === 'number' && (
//                       <Text style={{color: '#FFD700', marginTop: 4}}>
//                         {'⭐'.repeat(o.rating)} {'☆'.repeat(5 - o.rating)}
//                       </Text>
//                     )}
//                   </View>
//                 ))}
//               </ScrollView>
//             </View>
//           </View>
//         )}
//       </View>
//     </View>
//   );
// }

//////////////////

// import React, {useEffect, useState} from 'react';
// import {View, Text, ScrollView, Image, StyleSheet} from 'react-native';
// import {useAuth0} from 'react-native-auth0';
// import {Calendar, DateObject} from 'react-native-calendars';
// import {useAppTheme} from '../context/ThemeContext';
// import {useUUID} from '../context/UUIDContext';
// import {API_BASE_URL} from '../config/api';
// import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
// import {useGlobalStyles} from '../styles/useGlobalStyles';

// type WardrobeItem = {
//   id: string;
//   name: string;
//   image: string;
//   mainCategory: string;
//   subCategory: string;
//   material: string;
//   fit: string;
//   color: string;
//   size: string;
//   notes: string;
// };

// type SavedOutfit = {
//   id: string;
//   name?: string;
//   top: WardrobeItem | null;
//   bottom: WardrobeItem | null;
//   shoes: WardrobeItem | null;
//   createdAt: string;
//   tags?: string[];
//   notes?: string;
//   rating?: number;
//   favorited?: boolean;
//   plannedDate?: string;
//   type?: 'custom' | 'ai';
// };

// export default function OutfitPlannerScreen() {
//   const {user} = useAuth0();
//   const userId = useUUID() || user?.sub || '';
//   const {theme} = useAppTheme();
//   const globalStyles = useGlobalStyles();
//   const colors = theme.colors;

//   const styles = StyleSheet.create({
//     screen: {
//       flex: 1,
//       backgroundColor: theme.colors.background,
//     },
//     chipGroup: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       marginTop: 4,
//     },
//     input: {
//       borderWidth: 1,
//       borderColor: colors.surface,
//       borderRadius: 8,
//       paddingVertical: 8,
//       paddingHorizontal: 12,
//       fontSize: 16,
//       color: colors.foreground,
//     },
//     chipRow: {flexDirection: 'row', flexWrap: 'wrap', marginTop: 4},
//   });

//   const [scheduledOutfits, setScheduledOutfits] = useState<SavedOutfit[]>([]);
//   const [selectedDate, setSelectedDate] = useState<string | null>(null);
//   const [modalVisible, setModalVisible] = useState(false);

//   const normalizeImageUrl = (url: string | undefined | null): string => {
//     if (!url) return '';
//     return url.startsWith('http') ? url : `${API_BASE_URL}${url}`;
//   };

//   useEffect(() => {
//     if (!userId) return;

//     const fetchData = async () => {
//       try {
//         const [aiRes, customRes, scheduledRes] = await Promise.all([
//           fetch(`${API_BASE_URL}/outfit/suggestions/${userId}`),
//           fetch(`${API_BASE_URL}/outfit/custom/${userId}`),
//           fetch(`${API_BASE_URL}/scheduled-outfits/${userId}`),
//         ]);

//         if (!aiRes.ok || !customRes.ok || !scheduledRes.ok) {
//           throw new Error('Failed to fetch outfit schedule data');
//         }

//         const [aiData, customData, scheduledData] = await Promise.all([
//           aiRes.json(),
//           customRes.json(),
//           scheduledRes.json(),
//         ]);

//         const scheduleMap: Record<string, string> = {};
//         for (const s of scheduledData) {
//           if (s.ai_outfit_id) {
//             scheduleMap[s.ai_outfit_id] = s.scheduled_for;
//           } else if (s.custom_outfit_id) {
//             scheduleMap[s.custom_outfit_id] = s.scheduled_for;
//           }
//         }

//         const normalize = (o: any, isCustom: boolean): SavedOutfit | null => {
//           const id = o.id;
//           const plannedDate = scheduleMap[id];
//           if (!plannedDate) return null;

//           return {
//             id,
//             name: o.name || '',
//             top: o.top
//               ? {
//                   id: o.top.id,
//                   name: o.top.name,
//                   image: normalizeImageUrl(o.top.image || o.top.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             bottom: o.bottom
//               ? {
//                   id: o.bottom.id,
//                   name: o.bottom.name,
//                   image: normalizeImageUrl(
//                     o.bottom.image || o.bottom.image_url,
//                   ),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             shoes: o.shoes
//               ? {
//                   id: o.shoes.id,
//                   name: o.shoes.name,
//                   image: normalizeImageUrl(o.shoes.image || o.shoes.image_url),
//                   mainCategory: '',
//                   subCategory: '',
//                   material: '',
//                   fit: '',
//                   color: '',
//                   size: '',
//                   notes: '',
//                 }
//               : null,
//             createdAt: o.created_at
//               ? new Date(o.created_at).toISOString()
//               : new Date().toISOString(),
//             tags: o.tags || [],
//             notes: o.notes || '',
//             rating: o.rating ?? undefined,
//             favorited: false,
//             plannedDate,
//             type: isCustom ? 'custom' : 'ai',
//           };
//         };

//         const outfits = [
//           ...aiData.map(o => normalize(o, false)),
//           ...customData.map(o => normalize(o, true)),
//         ].filter(Boolean) as SavedOutfit[];

//         setScheduledOutfits(outfits);
//       } catch (err) {
//         console.error('❌ Failed to load calendar outfits:', err);
//       }
//     };

//     fetchData();
//   }, [userId]);

//   const markedDates = scheduledOutfits.reduce((acc, outfit) => {
//     const date = outfit.plannedDate!.split('T')[0];
//     if (!acc[date]) acc[date] = {dots: []};
//     acc[date].dots.push({
//       color: outfit.type === 'ai' ? '#405de6' : '#00c6ae',
//     });
//     return acc;
//   }, {} as Record<string, any>);

//   const outfitsByDate = scheduledOutfits.reduce((acc, outfit) => {
//     const date = outfit.plannedDate!.split('T')[0];
//     if (!acc[date]) acc[date] = [];
//     acc[date].push(outfit);
//     return acc;
//   }, {} as Record<string, SavedOutfit[]>);

//   const handleDayPress = (day: DateObject) => {
//     setSelectedDate(day.dateString);
//     setModalVisible(true);
//   };

//   return (
//     <View style={[globalStyles.container]}>
//       <Text style={[globalStyles.header, {marginBottom: 20}]}>
//         Planned Outfits
//       </Text>

//       <View style={globalStyles.section}>
//         <Calendar
//           onDayPress={handleDayPress}
//           markedDates={{
//             ...markedDates,
//             ...(selectedDate
//               ? {
//                   [selectedDate]: {
//                     selected: true,
//                     selectedColor: theme.colors.primary,
//                   },
//                 }
//               : {}),
//           }}
//           markingType="multi-dot"
//           theme={{
//             calendarBackground: theme.colors.background,
//             textSectionTitleColor: theme.colors.foreground2,
//             dayTextColor: theme.colors.foreground,
//             todayTextColor: theme.colors.primary,
//             selectedDayBackgroundColor: theme.colors.primary,
//             selectedDayTextColor: '#fff',
//             arrowColor: theme.colors.primary,
//             monthTextColor: theme.colors.primary,
//             textMonthFontWeight: 'bold',
//             textDayFontSize: 16,
//             textMonthFontSize: 18,
//             textDayHeaderFontSize: 14,
//             dotColor: theme.colors.primary,
//             selectedDotColor: '#fff',
//             disabledArrowColor: '#444',
//           }}
//         />

//         {modalVisible && (
//           <View
//             style={{
//               position: 'absolute',
//               top: 300, // keep your current vertical position
//               left: 0,
//               right: 0,
//               alignItems: 'center', // ⬅️ centers the inner card horizontally
//               backgroundColor: 'rgba(0,0,0,0.35)',
//               paddingVertical: 20,
//             }}>
//             <View
//               style={{
//                 backgroundColor: theme.colors.surface,
//                 borderRadius: 20,
//                 padding: 20,
//                 maxHeight: '100%',
//                 width: 'auto', // let width fit content
//                 minWidth: 400, // optional: enforce a comfortable min width
//                 alignSelf: 'center', // center horizontally
//               }}>
//               <Text
//                 style={{
//                   fontSize: 18,
//                   fontWeight: '600',
//                   color: theme.colors.foreground,
//                   marginBottom: 12,
//                   // textAlign: 'center',
//                 }}>
//                 Outfits on {selectedDate}
//               </Text>

//               <ScrollView>
//                 {(outfitsByDate[selectedDate!] || []).map((o, index) => (
//                   <View
//                     key={index}
//                     style={{
//                       marginBottom: 16,
//                       borderBottomWidth: 1,
//                       borderBottomColor: '#ddd',
//                       paddingBottom: 8,
//                     }}>
//                     <Text
//                       style={{color: theme.colors.foreground, fontSize: 16}}>
//                       {o.name?.trim() || 'Unnamed Outfit'}
//                     </Text>

//                     <View style={{flexDirection: 'row', marginTop: 8}}>
//                       {[o.top, o.bottom, o.shoes].map(item =>
//                         item?.image ? (
//                           <Image
//                             key={item.id}
//                             source={{uri: item.image}}
//                             style={{
//                               width: 60,
//                               height: 60,
//                               borderRadius: 8,
//                               marginRight: 8,
//                             }}
//                           />
//                         ) : null,
//                       )}
//                     </View>

//                     {o.notes ? (
//                       <Text
//                         style={{
//                           fontStyle: 'italic',
//                           color: theme.colors.foreground2,
//                           marginTop: 6,
//                         }}>
//                         {o.notes}
//                       </Text>
//                     ) : null}

//                     {typeof o.rating === 'number' && (
//                       <Text style={{color: '#FFD700', marginTop: 4}}>
//                         {'⭐'.repeat(o.rating)} {'☆'.repeat(5 - o.rating)}
//                       </Text>
//                     )}
//                   </View>
//                 ))}
//               </ScrollView>

//               <AppleTouchFeedback
//                 onPress={() => setModalVisible(false)}
//                 hapticStyle="impactMedium"
//                 style={{
//                   marginTop: 20,
//                   alignSelf: 'center',
//                   backgroundColor: theme.colors.secondary,
//                   paddingHorizontal: 16,
//                   paddingVertical: 8,
//                   borderRadius: 6,
//                 }}>
//                 <Text
//                   style={{
//                     color: 'white',
//                     fontWeight: '600',
//                   }}>
//                   Close
//                 </Text>
//               </AppleTouchFeedback>
//             </View>
//           </View>
//         )}
//       </View>
//     </View>
//   );
// }
