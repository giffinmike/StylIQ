import React, {useRef, useState, useEffect, useCallback, useMemo} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  TextInput,
  Keyboard,
  ScrollView,
  Dimensions,
  Animated,
  Easing,
  Modal,
  Share,
  Image,
  PanResponder,
  LayoutChangeEvent,
  Alert,
  KeyboardAvoidingView,
} from 'react-native';
import {WebView} from 'react-native-webview';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import {captureRef} from 'react-native-view-shot';
import {useAppTheme} from '../context/ThemeContext';
import {useShoppingStore} from '../../../../store/shoppingStore';
import {shoppingAnalytics} from '../../../../store/shoppingAnalytics';
import {triggerHaptic} from '../utils/haptics';
import ShoppingAssistant from '../components/ShoppingAssistant';
import {useUUID} from '../context/UUIDContext';
import {tokens} from '../styles/tokens/tokens';
import {LiquidGlassView, isLiquidGlassSupported} from '@callstack/liquid-glass';
import AutofillSettings from '../components/BrowserSettings/AutofillSettings';
import {fontScale, moderateScale} from '../utils/scale';
// 🔥 VOICE ADD/
import {useVoiceControl} from '../hooks/useVoiceControl';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {PermissionsAndroid, Platform} from 'react-native';
import ImageSaverModule from '../native/ImageSaverModule';
import {API_BASE_URL} from '../config/api';
import {getAccessToken} from '../utils/auth';
import AppleTouchFeedback from '../components/AppleTouchFeedback/AppleTouchFeedback';
import Icon from 'react-native-vector-icons/MaterialIcons';
import TrackingConsentModal from '../components/TrackingConsentModal/TrackingConsentModal';
import SwipeableCard from '../components/SwipeableCard/SwipeableCard';
// Security imports
import {
  SECURE_WEBVIEW_DEFAULTS,
  createOnShouldStartLoadWithRequest,
  createCrashRecoveryHandler,
} from '../config/webViewDefaults';
import {sanitizeTitle} from '../utils/sanitize';
import {sanitizeUrlForAnalytics} from '../utils/urlSanitizer';
import AsyncStorage from '@react-native-async-storage/async-storage';
// iOS Keychain AutoFill reliability imports
import {KeychainAuthBridge} from '../native/KeychainAuthBridge';
import {shouldShareCookiesForUrl} from '../utils/keychainCookiePolicy';
import {generateKeychainAutoFillScript} from '../utils/keychainAutoFillScript';
import {useBrowserOnboarding} from '../hooks/useBrowserOnboarding';
import {BrowserOnboardingModal} from '../components/BrowserOnboardingModal/BrowserOnboardingModal';
import Geolocation from 'react-native-geolocation-service';
import {ensureLocationPermission} from '../utils/permissions';

const {width: screenWidth} = Dimensions.get('window');
const TAB_CARD_WIDTH = (screenWidth - 48) / 2;
const TAB_CARD_HEIGHT = TAB_CARD_WIDTH * 1.4;

type Props = {
  route?: {params?: {url?: string; title?: string}};
  navigate: (screen: string, params?: any) => void;
  wardrobe: any[];
};

export default function WebBrowserScreen({navigate, route}: Props) {
  // 🔥 VOICE ADD
  const {speech, isRecording, startListening, stopListening} =
    useVoiceControl();
  const [isHoldingMic, setIsHoldingMic] = useState(false);
  const {theme} = useAppTheme();
  const insets = useSafeAreaInsets();
  const userId = useUUID();
  const {
    showModal: showBrowserOnboarding,
    isLoading: isOnboardingLoading,
    dismissModal: dismissBrowserOnboarding,
  } = useBrowserOnboarding();
  // Debug: Log only on actual mount, not every render
  useEffect(() => {
    // console.log('WebBrowserScreen mounted, userId:', userId);
  }, []);
  const initialUrl = route?.params?.url || '';
  const webRef = useRef<WebView>(null);
  const containerRef = useRef<View>(null);
  // SECURITY: Rate limiter for WebView messages to prevent DoS attacks
  const messageRateLimiter = useRef({count: 0, lastReset: Date.now()});
  const [inputValue, setInputValue] = useState(initialUrl);
  const [showTabsView, setShowTabsView] = useState(false);
  const tabsViewScale = useRef(new Animated.Value(0)).current;

  const {
    tabs,
    currentTabId,
    addTab,
    removeTab,
    switchTab,
    updateTab,
    updateTabScreenshot,
    reorderTabs,
    addBookmark,
    removeBookmark,
    isBookmarked,
    bookmarks,
    collections,
    addItemToCollection,
    history,
    addToHistory,
    addSearch,
    _hasHydrated,
    aiShoppingAssistantSuggestions,
    setAiShoppingAssistantSuggestions,
    hasAiSuggestionsLoaded,
    setHasAiSuggestionsLoaded,
    isAiSuggestionsStale,
    trackingConsent,
    setTrackingConsent,
    quickShopSites,
    addQuickShopSite,
    removeQuickShopSite,
    updateTabNavHistory,
    navigateTabBack,
    navigateTabForward,
    getTabCanGoBack,
    getTabCanGoForward,
  } = useShoppingStore();

  // iOS Password AutoFill - passwords are managed by iOS/iCloud Keychain
  // No app-level password storage needed - iOS handles everything securely

  // 🔥 VOICE ADD
  async function prepareAudio() {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) return false;
      } else {
        const AV = require('react-native').NativeModules.AVAudioSession;
        if (AV?.setCategory) {
          await AV.setCategory('PlayAndRecord');
          await AV.setActive(true);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // 🛍️ Fetch shopping suggestions with smart context classification
  async function fetchShoppingAssistantSuggestions() {
    if (!userId || (hasAiSuggestionsLoaded && !isAiSuggestionsStale())) {
      return;
    }

    const SHOPPING_PROMPT = `SHOPPING ASSISTANT MODE: Analyze the user's wardrobe, style profile, and calendar to generate 5 HIGHLY SPECIFIC personalized shopping recommendations.

🎯 CRITICAL REQUIREMENTS:
1. Access user's wardrobe inventory to identify SPECIFIC gaps (colors owned, categories missing, fit preferences)
2. Reference style profile: body type, preferred colors, disliked styles, climate
3. Check calendar for upcoming events needing specific pieces
4. NO GENERIC SUGGESTIONS - every recommendation must PROVE you know their wardrobe
5. EVERY recommendation MUST explicitly name SPECIFIC items they already own

⭐ MANDATORY WARDROBE REFERENCING (you MUST do this):
- Use language patterns like "pair with your [COLOR] [ITEM] you own"
- Examples of GOOD recommendations:
  • "Navy blazer - pairs perfectly with your sleek white pants and complements your gray cardigans"
  • "Camel belt - fills your warm-neutral gap; works with your dark bottoms and existing brown shoes"
  • "Black tailored trousers - adds formality; you have 8 tops (mostly navy/gray) but only 2 bottoms"
  • "Cream linen shirt - bridges your white and navy pieces; works for your business casual events next month"
  • "Burgundy wool sweater - complements your warm undertones and pairs with the cream chinos you own"

- Examples of BAD recommendations (NEVER do these):
  • ❌ "Elevate your look with a premium leather belt"
  • ❌ "Fill the gap with classic black trousers"
  • ❌ "Add a stylish blazer to complete your wardrobe"

Use strategies:
1. **CALENDAR**: Reference specific events and what they NEED
2. **WARDROBE_GAP**: Name specific missing colors or categories (e.g., "you lack warm-toned bottoms") AND list similar items they own
3. **STYLE_UPGRADE**: Reference existing pieces BY NAME and suggest exact complementary items
4. **TRENDING**: Name trending style AND explain why THEIR specific aesthetic needs it
5. **COMPLETE_LOOK**: Reference saved outfits and name SPECIFIC pieces missing

Respond with JSON array of exactly 5 objects with SPECIFIC recommendations:
[
  {"text": "[Color] [fit] [garment] - [concrete reason naming specific items they own]", "site": "https://nordstrom.com", "search": "[specific search]", "strategy": "calendar"},
  ...
]`;

    try {
      const accessToken = await getAccessToken();
      const response = await fetch(`${API_BASE_URL}/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          user_id: userId,
          messages: [{role: 'user', content: SHOPPING_PROMPT}],
        }),
      });

      if (!response.ok) throw new Error('AI request failed');

      const data = await response.json();
      const aiText = data.reply || data.text || data.response || '';

      try {
        const parsed = JSON.parse(aiText.match(/\[[\s\S]*\]/)?.[0] || '[]');
        if (Array.isArray(parsed) && parsed.length > 0) {
          setAiShoppingAssistantSuggestions(parsed);
          setHasAiSuggestionsLoaded(true);
        }
      } catch {
        // Failed to parse shopping suggestions
      }
    } catch (err) {
      // Shopping suggestions fetch failed
    }
  }

  // Memoize currentTab to prevent unnecessary recalculations
  const currentTab = useMemo(
    () => tabs.find(t => t.id === currentTabId),
    [tabs, currentTabId],
  );
  const bookmarked = currentTab ? isBookmarked(currentTab.url) : false;
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [showCollectionPicker, setShowCollectionPicker] = useState(false);
  const [showBookmarksModal, setShowBookmarksModal] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [activeBookmarksTab, setActiveBookmarksTab] = useState<
    'bookmarks' | 'history'
  >('bookmarks');
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showAutofillSettings, setShowAutofillSettings] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState('');

  // Image long-press save state
  const [longPressedImageUrl, setLongPressedImageUrl] = useState<string | null>(
    null,
  );
  const [showImageSaveModal, setShowImageSaveModal] = useState(false);
  const [showConsentModal, setShowConsentModal] = useState(false);

  // Add Quick Shop Site modal state
  const [showAddSiteModal, setShowAddSiteModal] = useState(false);
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteUrl, setNewSiteUrl] = useState('');

  // Drag and drop state for tabs
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [draggedOverIndex, setDraggedOverIndex] = useState<number | null>(null);
  const dragAnimatedValue = useRef(new Animated.ValueXY()).current;
  const dragScale = useRef(new Animated.Value(1)).current;
  const tabPositions = useRef<
    {x: number; y: number; width: number; height: number}[]
  >([]);

  // GOLD: Tracking refs
  const pageStartTimeRef = useRef<number>(0);
  const sessionStartedRef = useRef<boolean>(false);
  const maxScrollDepthRef = useRef<number>(0);
  const previousUrlRef = useRef<string>('');
  const lastPageTextRef = useRef<string>('');

  // Debounce navigation state changes to prevent rapid URL toggling
  const navStateDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const lastNavUrlRef = useRef<string>('');
  const isNavHistoryNavigation = useRef<boolean>(false); // Track if we're doing back/forward

  // GOLD #7 & #10: Track sizes and colors clicked on current page
  const sizesClickedRef = useRef<{size: string; timestamp: number}[]>([]);
  const colorsClickedRef = useRef<{color: string; timestamp: number}[]>([]);

  // iOS Keychain AutoFill state
  // Tracks auth flow to pause navigation during Face ID/Touch ID
  const isKeychainAuthActiveRef = useRef<boolean>(false);
  const pendingNavigationRef = useRef<string | null>(null);
  const keychainScriptInjectedRef = useRef<boolean>(false);

  // Safari-style loading progress bar state
  const [loadProgress, setLoadProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const progressAnimValue = useRef(new Animated.Value(0)).current;

  // Debug info display
  const [debugInfo, setDebugInfo] = useState<{
    price?: number;
    brand?: string;
    category?: string;
    pageTextLength?: number;
    pageTextPreview?: string;
    inputText?: string;
    timestamp?: number;
    sizesViewed?: string[];
    colorsViewed?: string[];
  } | null>(null);
  const [showDebugDetail, setShowDebugDetail] = useState(false);

  // Initialize with a tab if navigating with URL (wait for hydration)
  const initialUrlProcessedRef = useRef(false);
  useEffect(() => {
    if (_hasHydrated && initialUrl && !initialUrlProcessedRef.current) {
      initialUrlProcessedRef.current = true;
      // Check if this URL is already open in a tab
      const existingTab = tabs.find(t => t.url === initialUrl);
      if (existingTab) {
        // Switch to existing tab
        switchTab(existingTab.id);
      } else {
        // Add new tab with the URL
        addTab(initialUrl, 'New Tab');
      }
    }
  }, [_hasHydrated, initialUrl]);

  // Update input when tab changes (only when switching tabs, not during navigation)
  const lastTabIdRef = useRef(currentTabId);

  // Track last cart detection to prevent duplicates
  const lastCartDetectionRef = useRef<{url: string; timestamp: number} | null>(
    null,
  );
  // Track last purchase detection to prevent duplicates
  const lastPurchaseDetectionRef = useRef<{
    url: string;
    timestamp: number;
  } | null>(null);
  useEffect(() => {
    // Only update inputValue when we actually switch to a different tab
    if (currentTabId !== lastTabIdRef.current) {
      lastTabIdRef.current = currentTabId;
      if (currentTab?.url) {
        setInputValue(currentTab.url);
      }
    }
  }, [currentTabId]);

  // Tracking Consent Prompt - show styled modal when user first opens browser
  // Wait for browser onboarding to complete first to avoid modal conflicts
  useEffect(() => {
    if (
      _hasHydrated &&
      trackingConsent === 'pending' &&
      !isOnboardingLoading &&
      !showBrowserOnboarding
    ) {
      // Small delay to let screen render first
      const timer = setTimeout(() => {
        setShowConsentModal(true);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [_hasHydrated, trackingConsent, isOnboardingLoading, showBrowserOnboarding]);

  const handleConsentAccept = useCallback(() => {
    setTrackingConsent('accepted');
    setShowConsentModal(false);
  }, [setTrackingConsent]);

  const handleConsentDecline = useCallback(() => {
    setTrackingConsent('declined');
    setShowConsentModal(false);
  }, [setTrackingConsent]);

  // GOLD #1, #3: Start session on first load (don't end it on unmount)
  useEffect(() => {
    if (!sessionStartedRef.current) {
      const currentSession = useShoppingStore.getState().currentSessionId;
      if (!currentSession) {
        useShoppingStore.getState().startSession();
      }
      sessionStartedRef.current = true;
    }
  }, []);

  // 🛍️ Fetch AI Shopping Suggestions once per app session (or if stale after 24h)
  // Only fetch if the shopping assistant is enabled
  const fetchingRef = useRef(false);
  useEffect(() => {
    const checkAndFetch = async () => {
      // Check if shopping assistant is disabled
      const disabled = await AsyncStorage.getItem(
        '@shopping_assistant_suggestions_disabled',
      );
      if (disabled === 'true') return;

      if (
        userId &&
        (!hasAiSuggestionsLoaded || isAiSuggestionsStale()) &&
        !fetchingRef.current
      ) {
        fetchingRef.current = true;
        fetchShoppingAssistantSuggestions().finally(() => {
          fetchingRef.current = false;
        });
      }
    };
    checkAndFetch();
  }, [userId, hasAiSuggestionsLoaded]);

  // iOS Password AutoFill handles password injection automatically via iCloud Keychain
  // No JavaScript injection needed - iOS fills passwords directly into WebView forms

  // GOLD #1, #9: Track dwell time and scroll depth when page loads
  useEffect(() => {
    // Skip if no URL or if we've already tracked this URL (ignore www/trailing slash differences)
    if (!currentTab?.url) return;

    // Normalize for comparison to avoid www/trailing slash loops
    const normalizeForCompare = (url: string) => {
      try {
        const u = new URL(url);
        return (
          u.origin.replace('://www.', '://') +
          u.pathname.replace(/\/$/, '') +
          u.search
        );
      } catch {
        return url;
      }
    };

    if (
      previousUrlRef.current &&
      normalizeForCompare(currentTab.url) ===
        normalizeForCompare(previousUrlRef.current)
    ) {
      return;
    }

    // If we had a previous page, save its metrics before moving to new page
    if (previousUrlRef.current && pageStartTimeRef.current > 0) {
      const dwell = Math.round((Date.now() - pageStartTimeRef.current) / 1000);
      useShoppingStore
        .getState()
        .updateHistoryMetadata(previousUrlRef.current, {
          dwellTime: dwell,
          scrollDepth: maxScrollDepthRef.current,
        });
    }

    // Now start tracking the new page
    pageStartTimeRef.current = Date.now();
    maxScrollDepthRef.current = 0; // Reset scroll depth for new page
    previousUrlRef.current = currentTab.url; // Store for next page transition
    const source = getDomain(currentTab.url);
    // Extract brand from URL/title for history tracking
    const brand = shoppingAnalytics.extractBrand(
      currentTab.title || '',
      currentTab.url,
    );
    useShoppingStore
      .getState()
      .addToHistory(
        currentTab.url,
        currentTab.title || 'New Tab',
        source,
        brand,
      );

    // Record as a product view interaction
    useShoppingStore
      .getState()
      .recordProductInteraction(currentTab.url, 'view');
  }, [currentTab?.url]);

  // 🔥 VOICE ADD — Update inputValue when speech updates
  useEffect(() => {
    if (speech && isHoldingMic === false) {
      setInputValue(speech);
    }
  }, [speech]);

  const getDomain = (url: string) => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return url || 'New Tab';
    }
  };

  // Normalize URLs for comparison (ignore www and trailing slash differences)
  const normalizeUrlForComparison = (url: string) => {
    try {
      const urlObj = new URL(url);
      // Remove www. and trailing slash for comparison
      return (
        urlObj.origin.replace('://www.', '://') +
        urlObj.pathname.replace(/\/$/, '') +
        urlObj.search
      );
    } catch {
      return url;
    }
  };

  // Check if two URLs are effectively the same (ignoring www and trailing slash)
  const isSameUrl = (url1: string, url2: string) => {
    return normalizeUrlForComparison(url1) === normalizeUrlForComparison(url2);
  };

  const extractImageFromPage = (url: string): string => {
    // Use DuckDuckGo favicon service (more reliable)
    try {
      const domain = new URL(url).hostname;
      // DuckDuckGo favicon service
      return `https://icons.duckduckgo.com/ip3/${domain}.ico`;
    } catch {
      return '';
    }
  };

  const normalizeUrl = (text: string): string => {
    const normalized = text.trim();
    if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
      return normalized;
    }
    // Check if it looks like a domain (has a dot and looks like a valid domain pattern)
    // Valid domain patterns: example.com, sub.example.com, example.co.uk, etc.
    if (normalized.includes('.') && !normalized.includes(' ')) {
      // Check if it has a valid TLD or domain structure
      const parts = normalized.split('.');
      const lastPart = parts[parts.length - 1];
      // Check if the last part (potential TLD) is at least 2 characters and is alphabetic
      if (lastPart.length >= 2 && /^[a-zA-Z]+$/.test(lastPart)) {
        // Looks like a valid domain
        return `https://${normalized}`;
      }
    }
    // Treat as search query
    return `https://google.com/search?q=${encodeURIComponent(normalized)}`;
  };

  const handleSubmit = () => {
    if (inputValue.trim()) {
      const normalized = inputValue.trim();
      const newUrl = normalizeUrl(normalized);

      // Track search if user typed a search query (not a full URL)
      if (
        !normalized.startsWith('http://') &&
        !normalized.startsWith('https://') &&
        !normalized.includes('.')
      ) {
        // This is a plain search query
        addSearch(normalized);
      } else if (newUrl.includes('google.com/search?q=')) {
        // User typed a domain-like query that got converted to Google search
        try {
          const query = new URLSearchParams(new URL(newUrl).search).get('q');
          if (query) {
            addSearch(query);
          }
        } catch (e) {
          // URL parsing failed, skip search tracking
        }
      }

      if (currentTab) {
        updateTab(currentTab.id, newUrl, currentTab.title);
      } else {
        addTab(newUrl, 'New Tab');
      }
    }
    Keyboard.dismiss();
  };

  // Set URL and navigate - same flow as manual typing
  const handleQuickShop = useCallback(
    (url: string) => {
      const newUrl = normalizeUrl(url);
      setInputValue(newUrl);
      if (currentTab) {
        updateTab(currentTab.id, newUrl, getDomain(url));
      } else {
        addTab(newUrl, getDomain(url));
      }
    },
    [currentTab, updateTab, addTab],
  );

  // Autocomplete suggestions from history
  const autocompleteSuggestions = React.useMemo(() => {
    if (!isInputFocused || inputValue.length < 1) return [];
    const searchTerm = inputValue.toLowerCase();
    return history
      .filter(
        item =>
          item.url.toLowerCase().includes(searchTerm) ||
          item.title.toLowerCase().includes(searchTerm),
      )
      .sort((a, b) => b.visitCount - a.visitCount)
      .slice(0, 5);
  }, [history, inputValue, isInputFocused]);

  const handleAutocompleteSelect = (url: string) => {
    setInputValue(url);
    setShowAutocomplete(false);
    if (currentTab) {
      updateTab(currentTab.id, url, currentTab.title);
    } else {
      addTab(url, 'New Tab');
    }
    Keyboard.dismiss();
  };

  const handleSaveMenuOpen = () => {
    if (!currentTab || !currentTab.url) return;
    triggerHaptic('impactLight');
    setShowSaveMenu(true);
  };

  const handleAddToBookmarks = async () => {
    if (!currentTab) return;
    triggerHaptic('impactLight');
    if (bookmarked) {
      const bookmark = bookmarks.find(b => b.url === currentTab.url);
      if (bookmark) {
        removeBookmark(bookmark.id);
      }
    } else {
      // Capture screenshot for the bookmark preview
      let screenshot: string | undefined;
      if (containerRef.current) {
        try {
          screenshot = await captureRef(containerRef, {
            format: 'jpg',
            quality: 0.7,
            result: 'data-uri',
          });
        } catch (e) {
          console.log('Failed to capture bookmark screenshot:', e);
        }
      }

      // Try to extract page text right now via JavaScript injection
      // This provides fresh data at bookmark time
      if (webRef.current) {
        // Clear previous text to ensure we get fresh content
        lastPageTextRef.current = '';

        const extractScript = `
          (function() {
            try {
              const text = document.body.innerText.substring(0, 10000);
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'pageText',
                content: text,
                length: text.length,
                extracted: true
              }));
            } catch (e) {}
          })();
          true;
        `;
        webRef.current.injectJavaScript(extractScript);

        // Wait for message with timeout - poll until we get text or timeout
        const startTime = Date.now();
        while (!lastPageTextRef.current && Date.now() - startTime < 500) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        // console.log(
        //   '[Bookmark] Page text received:',
        //   lastPageTextRef.current?.length || 0,
        //   'chars',
        // );
      }

      // GOLD: Enrich bookmark with gold data
      const bookmarkId = Date.now().toString();
      const dwell = Math.round((Date.now() - pageStartTimeRef.current) / 1000);
      const category = shoppingAnalytics.extractCategory(
        currentTab.title || '',
        currentTab.url,
      );
      const brand = shoppingAnalytics.extractBrand(
        currentTab.title || '',
        currentTab.url,
      );

      // Extract price from title + URL + any cached page text
      let price = shoppingAnalytics.extractPrice(
        `${currentTab.title || ''} ${currentTab.url}`,
      );

      // If not found, try the page text we captured
      if (!price && lastPageTextRef.current) {
        price = shoppingAnalytics.extractPrice(lastPageTextRef.current);
      }

      // GOLD #7 & #10: Extract unique sizes and colors clicked
      const sizesViewed = [
        ...new Set(sizesClickedRef.current.map(s => s.size)),
      ];
      const colorsViewed = [
        ...new Set(colorsClickedRef.current.map(c => c.color)),
      ];

      // DEBUG: Show what was extracted
      const inputText = `${currentTab.title || ''} ${currentTab.url}`;
      setDebugInfo({
        price,
        brand,
        category,
        pageTextLength: lastPageTextRef.current?.length || 0,
        pageTextPreview: lastPageTextRef.current?.substring(0, 200) || '',
        inputText,
        timestamp: Date.now(),
        sizesViewed,
        colorsViewed,
      });

      addBookmark({
        id: bookmarkId,
        title: currentTab.title || getDomain(currentTab.url),
        url: currentTab.url,
        source: getDomain(currentTab.url),
        imageUrl: extractImageFromPage(currentTab.url),
        screenshot,
        addedAt: Date.now(),
        viewCount: 1,
        category, // GOLD #2
        brand, // GOLD #2b: Brand extracted from title/URL
        price, // GOLD #4: Initial price
        priceHistory: price ? [{price, date: Date.now()}] : [], // GOLD #4: Price history
        sizesViewed, // GOLD #7: Sizes clicked before bookmarking
        colorsViewed, // GOLD #10: Colors clicked before bookmarking
      });

      // Track as add-to-cart interaction if it's a cart page
      if (shoppingAnalytics.isCartUrl(currentTab.url)) {
        useShoppingStore
          .getState()
          .recordProductInteraction(currentTab.url, 'add_to_cart');

        // GOLD: Also record as a checkout_start event if on checkout page
        const isCheckout = /(checkout|payment|order)/.test(
          currentTab.url.toLowerCase(),
        );
        useShoppingStore.getState().recordCartEvent({
          type: isCheckout ? 'checkout_start' : 'add',
          timestamp: Date.now(),
          cartUrl: currentTab.url,
        });
      }

      // Record bookmark interaction
      useShoppingStore
        .getState()
        .recordProductInteraction(currentTab.url, 'bookmark');

      // DERIVED METRIC: Record time-to-action for bookmark
      useShoppingStore
        .getState()
        .recordTimeToAction(currentTab.url, 'bookmark', dwell);

      // GOLD #1, #9: Update history with dwell time and scroll depth
      useShoppingStore.getState().updateHistoryMetadata(currentTab.url, {
        dwellTime: dwell,
        scrollDepth: maxScrollDepthRef.current,
        isCartPage: shoppingAnalytics.isCartUrl(currentTab.url),
      });
    }
    setShowSaveMenu(false);
  };

  const handleAddToCollection = async (collectionId: string) => {
    if (!currentTab) return;
    triggerHaptic('impactLight');
    // Capture screenshot for the collection item preview
    let screenshot: string | undefined;
    if (containerRef.current) {
      try {
        screenshot = await captureRef(containerRef, {
          format: 'jpg',
          quality: 0.7,
          result: 'data-uri',
        });
      } catch (e) {
        console.log('Failed to capture collection item screenshot:', e);
      }
    }
    addItemToCollection(collectionId, {
      id: Date.now().toString(),
      title: currentTab.title || getDomain(currentTab.url),
      url: currentTab.url,
      source: getDomain(currentTab.url),
      imageUrl: extractImageFromPage(currentTab.url),
      screenshot,
      addedAt: Date.now(),
    });
    setShowCollectionPicker(false);
    setShowSaveMenu(false);
  };

  const handleShare = async () => {
    if (!currentTab || !currentTab.url) return;
    triggerHaptic('impactLight');
    try {
      await Share.share({
        url: currentTab.url,
        title: currentTab.title || getDomain(currentTab.url),
        message: `${currentTab.title || getDomain(currentTab.url)}\n${
          currentTab.url
        }`,
      });
      setShowSaveMenu(false);
      setShowShareMenu(false);
    } catch (error) {
      console.error('Error sharing:', error);
    }
  };

  const handleShareToNotes = () => {
    if (!currentTab || !currentTab.url) return;
    triggerHaptic('impactLight');
    setShowShareMenu(false);
    navigate('SaveNote', {
      url: currentTab.url,
      title: currentTab.title || getDomain(currentTab.url),
      content: '',
    });
  };

  const handleShareButtonPress = () => {
    if (!currentTab || !currentTab.url) return;
    triggerHaptic('impactLight');
    setShowShareMenu(true);
  };

  const handleOpenBookmarks = () => {
    triggerHaptic('impactLight');
    setShowSaveMenu(false);
    setShowBookmarksModal(true);
  };

  const handleBookmarkNavigation = (url: string, title: string) => {
    triggerHaptic('impactLight');
    if (currentTab) {
      updateTab(currentTab.id, url, title);
    } else {
      addTab(url, title);
    }
    setShowBookmarksModal(false);
  };

  // iOS Password AutoFill handles password saving automatically via iCloud Keychain
  // When user submits a login form, iOS prompts to save password to iCloud Keychain
  // No app-level password capture needed

  // Extract and cache page text when page loads, and inject size/color click listeners
  const handleWebViewLoadEnd = useCallback(() => {
    if (!webRef.current) return;

    const currentUrl = currentTab?.url?.toLowerCase() || '';

    // Reset auth state on new page load
    isKeychainAuthActiveRef.current = false;
    pendingNavigationRef.current = null;
    keychainScriptInjectedRef.current = false;
    KeychainAuthBridge.resetAuthFlow().catch(() => {});

    // =========================================================================
    // KEYCHAIN AUTOFILL SCRIPT INJECTION
    // This script is SAFE to inject on ALL HTTPS pages because:
    // 1. It only OBSERVES focus/blur/submit events - never modifies forms
    // 2. It NEVER reads input values - only event types are signaled
    // 3. It enables iOS Keychain AutoFill reliability, especially for modals
    // =========================================================================
    if (currentUrl.startsWith('https://')) {
      const keychainScript = generateKeychainAutoFillScript();
      webRef.current.injectJavaScript(keychainScript);
      // console.log('[Keychain] AutoFill script injected');
    }

    // Security: Only inject tracking scripts on HTTPS pages
    if (!currentUrl.startsWith('https://')) {
      console.log(
        '[SECURITY] Skipping tracking script injection on non-HTTPS page',
      );
      return;
    }

    // Security: Skip TRACKING scripts on login/auth AND payment/checkout pages
    // (Keychain script is still injected above as it's read-only)
    const sensitivePagePatterns = [
      // Auth pages
      '/login',
      '/signin',
      '/sign-in',
      '/auth',
      '/authenticate',
      '/password',
      '/account/login',
      '/oauth',
      '/sso',
      // Payment/checkout pages (PCI safety)
      '/checkout',
      '/payment',
      '/billing',
      '/pay/',
      '/order',
      '/confirm',
      '/purchase',
      '/cart/checkout',
      '/secure/',
    ];
    const isSensitivePage = sensitivePagePatterns.some(pattern =>
      currentUrl.includes(pattern),
    );
    if (isSensitivePage) {
      // console.log('[SECURITY] Skipping tracking script injection on sensitive page');
      return;
    }

    // Reset size/color tracking for new page
    sizesClickedRef.current = [];
    colorsClickedRef.current = [];

    const extractPageTextScript = `
      (function() {
        try {
          const text = document.body.innerText.substring(0, 5000);
          const data = {
            type: 'pageText',
            content: text,
            length: text.length,
            extracted: true
          };
          window.ReactNativeWebView.postMessage(JSON.stringify(data));
        } catch (err) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'pageText',
            content: '',
            error: err.message,
            extracted: false
          }));
        }
      })();
      true;
    `;

    // GOLD #7 & #10: Inject size/color click detection
    const sizeColorClickScript = `
      (function() {
        if (window.__styliqClickListenersAdded) return;
        window.__styliqClickListenersAdded = true;

        // Common size selector patterns across shopping sites
        const sizePatterns = [
          // Text patterns for sizes
          /^(XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL)$/i,
          /^(\\d{1,2}(\\.\\d)?)(\\s)?(US|UK|EU)?$/i, // 8, 8.5, 10 US, 42 EU
          /^(\\d{2})([RWLS])?$/i, // 32R, 34L, 28W
          /^(One Size|OS|OSFA|Free Size)$/i,
          /^(Small|Medium|Large|Extra Large)$/i,
        ];

        // Common color patterns
        const colorPatterns = [
          /^(black|white|red|blue|green|yellow|orange|purple|pink|gray|grey|brown|beige|navy|cream|ivory|tan|olive|maroon|teal|coral|gold|silver)$/i,
          /^(light|dark|bright|pale|deep)?\\s?(black|white|red|blue|green|yellow|orange|purple|pink|gray|grey|brown|beige|navy)$/i,
        ];

        const commonColors = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey', 'brown', 'beige', 'navy', 'cream', 'ivory', 'tan', 'olive', 'maroon', 'teal', 'coral', 'gold', 'silver', 'burgundy', 'charcoal', 'khaki', 'mint', 'rose', 'lavender', 'turquoise'];

        function isSize(text) {
          const trimmed = text.trim();
          if (!trimmed || trimmed.length > 20) return false;
          return sizePatterns.some(pattern => pattern.test(trimmed));
        }

        function isColor(text) {
          const trimmed = text.trim().toLowerCase();
          if (!trimmed || trimmed.length > 30) return false;
          if (commonColors.includes(trimmed)) return true;
          return colorPatterns.some(pattern => pattern.test(trimmed));
        }

        function getColorFromElement(el) {
          // Check text content
          const text = el.textContent?.trim() || '';
          if (isColor(text)) return text;

          // Check aria-label
          const ariaLabel = el.getAttribute('aria-label') || '';
          if (isColor(ariaLabel)) return ariaLabel;

          // Check title
          const title = el.getAttribute('title') || '';
          if (isColor(title)) return title;

          // Check data attributes
          const dataColor = el.getAttribute('data-color') || el.getAttribute('data-value') || '';
          if (isColor(dataColor)) return dataColor;

          // Check background color (color swatches)
          const bgColor = window.getComputedStyle(el).backgroundColor;
          if (bgColor && bgColor !== 'transparent' && bgColor !== 'rgba(0, 0, 0, 0)') {
            // Return a simplified color description
            return 'color-swatch';
          }

          return null;
        }

        // Add click listener to document
        document.addEventListener('click', function(e) {
          const target = e.target;
          if (!target) return;

          // Check clicked element and its parents (up to 3 levels)
          let el = target;
          for (let i = 0; i < 3 && el; i++) {
            const text = el.textContent?.trim() || '';

            // Check for size click
            if (isSize(text)) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'sizeClick',
                size: text.toUpperCase()
              }));
              return;
            }

            // Check for color click
            const color = getColorFromElement(el);
            if (color) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'colorClick',
                color: color
              }));
              return;
            }

            el = el.parentElement;
          }
        }, true);
      })();
      true;
    `;

    // GOLD: Cart detection script - extracts item count and estimated total
    const cartDetectionScript = `
      (function() {
        function detectCart() {
          try {
            // Look for common cart indicators
            const pageUrl = window.location.href;
            const isCartPage = /(cart|bag|basket|checkout|gp\\/cart)/.test(pageUrl.toLowerCase());

            if (!isCartPage) return false;

            // Extract item count from common patterns
            let itemCount = 0;

            // Pattern 1: Amazon-specific - look for cart count in various places
            const amazonCartCount = document.querySelector('#nav-cart-count, .nav-cart-count, [data-csa-c-type="widget"][data-csa-c-slot-id="nav-cart-count"]');
            if (amazonCartCount) {
              const count = parseInt(amazonCartCount.textContent.trim());
              if (!isNaN(count)) itemCount = count;
            }

            // Pattern 2: "Items in cart: X" or "Cart (X)"
            if (itemCount === 0) {
              const countMatch = document.body.innerText.match(/(?:cart|bag|basket)\\s*\\(?(\\d+)\\)?/i);
              if (countMatch) itemCount = parseInt(countMatch[1]);
            }

            // Pattern 3: Look for cart badge/counter elements
            if (itemCount === 0) {
              const badges = document.querySelectorAll('[class*="cart"], [class*="badge"], [class*="count"], [class*="qty"]');
              for (const badge of badges) {
                const text = badge.textContent.trim();
                const match = text.match(/^\\d+$/);
                if (match) {
                  itemCount = parseInt(match[0]);
                  break;
                }
              }
            }

            // Extract estimated total - Amazon specific patterns first
            let estimatedTotal = 0;

            // Amazon subtotal patterns
            const amazonSubtotal = document.querySelector('#sc-subtotal-amount-activecart, .sc-subtotal-amount, [data-name="Subtotal"]');
            if (amazonSubtotal) {
              const priceMatch = amazonSubtotal.textContent.match(/[$£€¥]\\s*([\\d,]+\\.?\\d*)/);
              if (priceMatch) {
                estimatedTotal = parseFloat(priceMatch[1].replace(/,/g, ''));
              }
            }

            // Generic total patterns
            if (estimatedTotal === 0) {
              const totalMatch = document.body.innerText.match(/(?:subtotal|total|cart total)[:\\s]*[$£€¥]\\s*([\\d,]+\\.?\\d*)/i);
              if (totalMatch) {
                estimatedTotal = parseFloat(totalMatch[1].replace(/,/g, ''));
              }
            }

            // Only send if we found something meaningful
            if (itemCount > 0 || estimatedTotal > 0) {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'cartDetected',
                itemCount: itemCount,
                estimatedTotal: estimatedTotal,
                cartUrl: pageUrl
              }));
              return true;
            }
            return false;
          } catch (e) {
            console.log('Cart detection error:', e);
            return false;
          }
        }

        // Try immediately
        if (!detectCart()) {
          // Retry after delays for dynamically loaded content
          setTimeout(detectCart, 500);
          setTimeout(detectCart, 1500);
          setTimeout(detectCart, 3000);
        }
      })();
      true;
    `;

    // GOLD: Purchase completion detection - detects order confirmation pages
    // IMPORTANT: Must be strict to avoid false positives on cart pages
    const purchaseDetectionScript = `
      (function() {
        try {
          const pageUrl = window.location.href.toLowerCase();
          const pageText = document.body.innerText.toLowerCase();
          const pageTitle = document.title.toLowerCase();

          // First, explicitly exclude cart/checkout pages that are NOT confirmations
          const isCartPage = /(cart|bag|basket|checkout|payment|shipping|billing)\\b/.test(pageUrl);
          const isCheckoutInProgress = /(enter.*address|payment.*method|select.*shipping|review.*order|place.*order|continue.*checkout|proceed.*checkout)/.test(pageText);

          if (isCartPage && isCheckoutInProgress) {
            // This is a checkout page in progress, not a confirmation
            return;
          }

          // Purchase completion indicators - must be VERY specific
          // Require order/confirmation number or specific completion language
          const hasOrderNumber = /(?:order|confirmation)\\s*(?:number|id|#)?[:\\s]+[A-Z0-9-]{4,}/i.test(pageText);
          const hasExplicitConfirmation = /(your order has been (placed|confirmed|received)|order successfully placed|purchase complete|thank you for your order|order confirmation|we've received your order)/.test(pageText);
          const isConfirmationUrl = /(order-confirmation|order-complete|order-success|checkout-success|thank-you.*order|confirmation.*complete)/.test(pageUrl);

          // Require at least 2 strong signals to confirm a purchase
          const signals = [hasOrderNumber, hasExplicitConfirmation, isConfirmationUrl].filter(Boolean).length;
          const isPurchaseConfirmation = signals >= 2 || (hasExplicitConfirmation && hasOrderNumber);

          if (isPurchaseConfirmation) {
            // Extract purchase details if available
            let orderNumber = '';
            let totalAmount = 0;

            // Try to find order number
            const orderMatch = pageText.match(/(?:order|confirmation)\\s*(?:number|id|#)?[:\\s]+([A-Z0-9-]+)/i);
            if (orderMatch) orderNumber = orderMatch[1];

            // Try to find total amount
            const totalMatch = pageText.match(/(?:total|amount|grand total)[:\\s]*[$£€¥]\\s*(\\d+(?:[.,]\\d{2})?)/i);
            if (totalMatch) {
              const totalStr = totalMatch[1].replace(',', '.');
              totalAmount = parseFloat(totalStr);
            }

            // Count items (look for common patterns)
            let itemCount = 0;
            const itemMatch = pageText.match(/(?:items?|products?)\\s*(?:ordered|purchased)?[:\\s]*([0-9]+)/i);
            if (itemMatch) itemCount = parseInt(itemMatch[1]);

            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'purchaseComplete',
              orderNumber: orderNumber,
              totalAmount: totalAmount,
              itemCount: itemCount,
              purchaseUrl: pageUrl,
              timestamp: Date.now()
            }));
          }
        } catch (e) {}
      })();
      true;
    `;

    // Image long-press detection script
    const imageLongPressScript = `
      (function() {
        if (window.__styliqImageLongPressAdded) return;
        window.__styliqImageLongPressAdded = true;

        let longPressTimer = null;
        let touchedImage = null;

        document.addEventListener('touchstart', function(e) {
          const target = e.target;
          if (target.tagName === 'IMG' && target.src) {
            touchedImage = target;
            longPressTimer = setTimeout(function() {
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'imageLongPress',
                imageUrl: touchedImage.src,
                alt: touchedImage.alt || ''
              }));
            }, 500);
          }
        }, {passive: true});

        document.addEventListener('touchend', function() {
          if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
          touchedImage = null;
        });

        document.addEventListener('touchmove', function() {
          if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
          }
        });
      })();
      true;
    `;

    // iOS Password AutoFill handles password detection and saving automatically
    // No JavaScript injection needed - iOS manages passwords via iCloud Keychain

    webRef.current.injectJavaScript(extractPageTextScript);
    webRef.current.injectJavaScript(sizeColorClickScript);
    webRef.current.injectJavaScript(cartDetectionScript);
    webRef.current.injectJavaScript(purchaseDetectionScript);
    webRef.current.injectJavaScript(imageLongPressScript);
  }, [currentTab?.url]);

  // Allowed message types from WebView (security allowlist)
  const ALLOWED_MESSAGE_TYPES = [
    'pageText',
    'sizeClick',
    'colorClick',
    'cartDetected',
    'purchaseComplete',
    'imageLongPress',
    // iOS Keychain AutoFill signals (read-only, no credential access)
    'keychainAuthStart',
    'keychainAuthBlur',
    'keychainAuthSubmit',
    'keychainModalDetected',
    'keychainPageHasPassword',
    'keychainPasswordFieldsFound',
    'keychainScriptInitialized',
    // Geolocation request from web pages
    'geolocationRequest',
    'geoDebug',
  ] as const;
  const MAX_MESSAGE_SIZE = 200 * 1024; // 200KB limit

  // Handle messages from WebView
  const handleWebViewMessage = useCallback((event: any) => {
    try {
      // SECURITY: Rate limiting - max 100 messages per second
      const now = Date.now();
      if (now - messageRateLimiter.current.lastReset > 1000) {
        messageRateLimiter.current = {count: 0, lastReset: now};
      }
      messageRateLimiter.current.count++;
      if (messageRateLimiter.current.count > 100) {
        // Only log once per second to avoid log spam
        if (messageRateLimiter.current.count === 101) {
          console.warn(
            '[SECURITY] Message rate limit exceeded - dropping messages',
          );
        }
        return;
      }

      // Security: Payload size limit
      const rawData = event.nativeEvent.data;
      if (typeof rawData !== 'string' || rawData.length > MAX_MESSAGE_SIZE) {
        console.log('[SECURITY] Blocked oversized message:', rawData?.length);
        return;
      }

      const data = JSON.parse(rawData);

      // Security: Type allowlist check
      if (
        !data.type ||
        !ALLOWED_MESSAGE_TYPES.includes(
          data.type as (typeof ALLOWED_MESSAGE_TYPES)[number],
        )
      ) {
        console.log('[SECURITY] Blocked unknown message type:', data.type);
        return;
      }

      if (data.type === 'geoDebug') {
        console.log('[WebView]', data.message);
      } else if (data.type === 'pageText') {
        lastPageTextRef.current = data.content || '';
        // console.log(
        //   '[MSG] Page text received:',
        //   data.length,
        //   'chars, extracted:',
        //   data.extracted,
        // );
      } else if (data.type === 'sizeClick') {
        // GOLD #7: Track size clicks with timestamp
        const sizeEntry = {size: data.size, timestamp: Date.now()};
        sizesClickedRef.current = [...sizesClickedRef.current, sizeEntry];
        console.log(
          '[MSG] Size clicked:',
          data.size,
          'Total:',
          sizesClickedRef.current.length,
        );
      } else if (data.type === 'colorClick') {
        // GOLD #10: Track color clicks with timestamp
        const colorEntry = {color: data.color, timestamp: Date.now()};
        colorsClickedRef.current = [...colorsClickedRef.current, colorEntry];
        console.log(
          '[MSG] Color clicked:',
          data.color,
          'Total:',
          colorsClickedRef.current.length,
        );
      } else if (data.type === 'cartDetected') {
        // GOLD: Cart detection with item count and total
        console.log('[MSG] Cart detected:', {
          itemCount: data.itemCount,
          estimatedTotal: data.estimatedTotal,
        });

        // Deduplicate: skip if same cart detected within 10 seconds
        const now = Date.now();
        const lastDetection = lastCartDetectionRef.current;
        if (
          lastDetection &&
          lastDetection.url === data.cartUrl &&
          now - lastDetection.timestamp < 10000
        ) {
          console.log('[MSG] Skipping duplicate cart detection');
          return;
        }
        lastCartDetectionRef.current = {url: data.cartUrl, timestamp: now};

        // Record cart view event
        useShoppingStore.getState().recordCartEvent({
          type: 'cart_view',
          timestamp: now,
          cartUrl: data.cartUrl,
          itemCount: data.itemCount,
          cartValue: data.estimatedTotal,
        });

        // DERIVED METRIC: Record time-to-action for cart
        const cartDwell = Math.round(
          (Date.now() - pageStartTimeRef.current) / 1000,
        );
        useShoppingStore
          .getState()
          .recordTimeToAction(data.cartUrl, 'cart', cartDwell);
      } else if (data.type === 'purchaseComplete') {
        // GOLD: Purchase completion detected on order confirmation page
        console.log('[MSG] Purchase complete detected:', {
          orderNumber: data.orderNumber,
          totalAmount: data.totalAmount,
          itemCount: data.itemCount,
        });

        // Deduplicate: skip if same purchase URL detected within 60 seconds
        // (purchase confirmation pages often reload/re-render)
        const now = Date.now();
        const lastPurchase = lastPurchaseDetectionRef.current;
        if (
          lastPurchase &&
          lastPurchase.url === data.purchaseUrl &&
          now - lastPurchase.timestamp < 60000
        ) {
          console.log('[MSG] Skipping duplicate purchase detection');
          return;
        }
        lastPurchaseDetectionRef.current = {
          url: data.purchaseUrl,
          timestamp: now,
        };

        // Record purchase completion event
        useShoppingStore.getState().recordCartEvent({
          type: 'checkout_complete',
          timestamp: data.timestamp || Date.now(),
          cartUrl: data.purchaseUrl,
          itemCount: data.itemCount,
          cartValue: data.totalAmount,
        });
      } else if (data.type === 'imageLongPress') {
        // Handle image long-press - show save options
        console.log('[MSG] Image long-pressed:', data.imageUrl);
        setLongPressedImageUrl(data.imageUrl);
        setShowImageSaveModal(true);
        triggerHaptic('impactMedium');
      }
      // ===================================================================
      // iOS KEYCHAIN AUTOFILL SIGNALS
      // These signals coordinate navigation with Face ID/Touch ID auth.
      // SECURITY: No credential data is ever accessed or transmitted.
      // ===================================================================
      else if (data.type === 'keychainAuthStart') {
        // Password field focused - auth flow starting
        // Pause navigation to prevent race condition with Face ID
        // console.log('[Keychain] Auth flow started - pausing navigation');
        isKeychainAuthActiveRef.current = true;
        KeychainAuthBridge.signalAuthFlowStarted().catch(() => {
          // Native module call failed - continue anyway
        });
      } else if (data.type === 'keychainAuthSubmit') {
        // Form submitted - auth flow complete
        // Resume navigation
        // console.log('[Keychain] Auth flow complete (submit) - resuming navigation');
        isKeychainAuthActiveRef.current = false;
        pendingNavigationRef.current = null;
        KeychainAuthBridge.signalAuthFlowCompleted().catch(() => {
          // Native module call failed - continue anyway
        });
      } else if (data.type === 'keychainAuthBlur') {
        // Password field blurred without submit - may or may not be complete
        // Use shorter timeout before resuming
        // console.log('[Keychain] Auth flow blur - will resume navigation shortly');
        setTimeout(() => {
          if (isKeychainAuthActiveRef.current) {
            isKeychainAuthActiveRef.current = false;
            KeychainAuthBridge.signalAuthFlowCompleted().catch(() => {});
          }
        }, 1000);
      } else if (data.type === 'keychainModalDetected') {
        // Dynamic modal with password field detected
        // Focus nudging will be applied by injected script
        console.log(
          '[Keychain] Modal with password field detected, fields:',
          data.fieldCount,
        );
      } else if (data.type === 'keychainPageHasPassword') {
        // Page has password fields - mark for Keychain script injection
        // console.log(
        //   '[Keychain] Page has password fields:',
        //   data.fieldCount,
        //   'inModal:',
        //   data.inModal,
        // );
      } else if (data.type === 'keychainScriptInitialized') {
        // Keychain script successfully initialized
        keychainScriptInjectedRef.current = true;
        // console.log(
        //   '[Keychain] Script initialized, hasPasswordFields:',
        //   data.hasPasswordFields,
        // );
      }
      // ===================================================================
      // GEOLOCATION HANDLING
      // Intercepts navigator.geolocation requests from web pages
      // ===================================================================
      else if (data.type === 'geolocationRequest') {
        console.log('[Geolocation] Request received from webpage, callbackId:', data.callbackId);
        const {callbackId} = data;

        // Request permission first, then get location
        (async () => {
          const hasPermission = await ensureLocationPermission();
          console.log('[Geolocation] Permission result:', hasPermission);

          if (!hasPermission) {
            console.log('[Geolocation] Permission denied');
            const errorResponse = `
              (function() {
                if (window.__geolocationCallbacks && window.__geolocationCallbacks['${callbackId}']) {
                  window.__geolocationCallbacks['${callbackId}'].error({
                    code: 1,
                    message: 'Location permission denied'
                  });
                  delete window.__geolocationCallbacks['${callbackId}'];
                }
              })();
              true;
            `;
            webRef.current?.injectJavaScript(errorResponse);
            return;
          }

          console.log('[Geolocation] Starting watchPosition for accurate fix...');

          // Use watchPosition to get an accurate GPS fix, then stop watching
          let responded = false;
          const watchId = Geolocation.watchPosition(
            position => {
              const accuracy = position.coords.accuracy;
              console.log('[Geolocation] Position update - lat:', position.coords.latitude, 'lng:', position.coords.longitude, 'accuracy:', accuracy, 'meters');

              // Only respond once we have reasonable accuracy (< 100 meters) or after first position
              if (!responded && (accuracy < 100 || accuracy)) {
                responded = true;
                Geolocation.clearWatch(watchId);

                console.log('[Geolocation] Sending to webpage - accuracy:', accuracy, 'meters');
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                const acc = position.coords.accuracy;
                const alt = position.coords.altitude;
                const altAcc = position.coords.altitudeAccuracy;
                const head = position.coords.heading;
                const spd = position.coords.speed;
                const ts = position.timestamp;

                const response = `
                  (function() {
                    var log = function(msg) {
                      console.log(msg);
                      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                        window.ReactNativeWebView.postMessage(JSON.stringify({type: 'geoDebug', message: msg}));
                      }
                    };
                    try {
                      log('[GeoJS] Looking for callback: ${callbackId}');
                      log('[GeoJS] __geolocationCallbacks exists: ' + !!window.__geolocationCallbacks);
                      log('[GeoJS] Callbacks: ' + (window.__geolocationCallbacks ? Object.keys(window.__geolocationCallbacks).join(',') : 'none'));
                      if (window.__geolocationCallbacks && window.__geolocationCallbacks['${callbackId}']) {
                        log('[GeoJS] Found callback, invoking...');
                        var cb = window.__geolocationCallbacks['${callbackId}'];
                        var posData = {
                          coords: {
                            latitude: ${lat},
                            longitude: ${lng},
                            accuracy: ${acc},
                            altitude: ${alt !== null ? alt : 'null'},
                            altitudeAccuracy: ${altAcc !== null ? altAcc : 'null'},
                            heading: ${head !== null ? head : 'null'},
                            speed: ${spd !== null ? spd : 'null'}
                          },
                          timestamp: ${ts}
                        };
                        log('[GeoJS] Calling success with lat:${lat} lng:${lng}');
                        cb.success(posData);
                        log('[GeoJS] SUCCESS - Callback invoked');
                        delete window.__geolocationCallbacks['${callbackId}'];
                      } else {
                        log('[GeoJS] ERROR: Callback NOT FOUND');
                      }
                    } catch(e) {
                      log('[GeoJS] EXCEPTION: ' + e.message);
                    }
                  })();
                  true;
                `;
                console.log('[Geolocation] Injecting JS, length:', response.length);
                webRef.current?.injectJavaScript(response);
                console.log('[Geolocation] JS injected');
              }
            },
            error => {
              if (!responded) {
                responded = true;
                Geolocation.clearWatch(watchId);
                console.log('[Geolocation] Error:', error.code, error.message);
                const errorResponse = `
                  (function() {
                    if (window.__geolocationCallbacks && window.__geolocationCallbacks['${callbackId}']) {
                      window.__geolocationCallbacks['${callbackId}'].error({
                        code: ${error.code},
                        message: '${error.message.replace(/'/g, "\\'")}'
                      });
                      delete window.__geolocationCallbacks['${callbackId}'];
                    }
                  })();
                  true;
                `;
                webRef.current?.injectJavaScript(errorResponse);
              }
            },
            {
              enableHighAccuracy: true,
              distanceFilter: 0,
              interval: 1000,
              fastestInterval: 500,
              forceRequestLocation: true,
              forceLocationManager: false,
              showLocationDialog: true,
            },
          );

          // Timeout fallback - if no accurate position after 15 seconds, use whatever we have
          setTimeout(() => {
            if (!responded) {
              console.log('[Geolocation] Timeout - clearing watch');
              Geolocation.clearWatch(watchId);
            }
          }, 15000);
        })();
      }
      // iOS Password AutoFill handles password saving automatically via iCloud Keychain
      // No app-level password handling needed
    } catch (e) {
      console.log('[MSG] Error parsing message:', e);
    }
  }, []);

  // Track last scroll Y for nav bar hide/show
  const lastNavScrollY = useRef(0);
  const bottomNavTranslateY = useRef(new Animated.Value(0)).current;
  const isBottomNavHidden = useRef(false);
  const NAV_HEIGHT = 100;
  const SCROLL_THRESHOLD = 3;

  // GOLD #9: Track scroll depth in WebView + nav bar hide/show
  const handleWebViewScroll = useCallback(
    (event: any) => {
      try {
        const {contentOffset, contentSize, layoutMeasurement} =
          event.nativeEvent;
        const diff = contentOffset.y - lastNavScrollY.current;

        // Scrolling down (up on screen) - hide nav
        if (
          diff > SCROLL_THRESHOLD &&
          !isBottomNavHidden.current &&
          contentOffset.y > 10
        ) {
          isBottomNavHidden.current = true;
          Animated.timing(bottomNavTranslateY, {
            toValue: NAV_HEIGHT + insets.bottom,
            duration: 300,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start();
        }
        // Scrolling up (down on screen) - show nav
        else if (diff < -SCROLL_THRESHOLD && isBottomNavHidden.current) {
          isBottomNavHidden.current = false;
          Animated.timing(bottomNavTranslateY, {
            toValue: 0,
            duration: 300,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }).start();
        }

        lastNavScrollY.current = contentOffset.y;

        if (contentSize.height > 0) {
          const scrollPosition = contentOffset.y;
          const viewportHeight = layoutMeasurement.height;
          const contentHeight = contentSize.height;
          // Calculate scroll depth as percentage (0-100)
          const scrollDepth = Math.min(
            100,
            Math.round(
              ((scrollPosition + viewportHeight) / contentHeight) * 100,
            ),
          );
          // Update max scroll depth reached
          if (scrollDepth > maxScrollDepthRef.current) {
            maxScrollDepthRef.current = scrollDepth;
          }
        }
      } catch (e) {
        // Silently fail if scroll metrics unavailable
      }
    },
    [bottomNavTranslateY, insets.bottom],
  );

  const captureCurrentTabScreenshot = useCallback(async () => {
    if (!containerRef.current || !currentTab || !currentTab.url) {
      // console.log('Screenshot skipped - no containerRef or currentTab');
      return;
    }
    try {
      // console.log('Capturing screenshot for tab:', currentTab.id);
      const uri = await captureRef(containerRef, {
        format: 'jpg',
        quality: 0.7,
        result: 'data-uri',
      });
      // console.log('Screenshot captured, length:', uri?.length);
      if (uri) {
        updateTabScreenshot(currentTab.id, uri);
        // console.log('Screenshot saved to tab');
      }
    } catch (error) {
      // console.log('Screenshot capture error:', error);
    }
  }, [currentTab, updateTabScreenshot]);

  const openTabsView = async () => {
    triggerHaptic('impactLight');
    // Capture screenshot of current tab before showing tabs view
    await captureCurrentTabScreenshot();
    setShowTabsView(true);
    Animated.spring(tabsViewScale, {
      toValue: 1,
      useNativeDriver: true,
      tension: 50,
      friction: 8,
    }).start();
  };

  const closeTabsView = () => {
    Animated.timing(tabsViewScale, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start(() => setShowTabsView(false));
  };

  const handleSelectTab = (tabId: string) => {
    if (draggingIndex !== null) return; // Don't select while dragging
    triggerHaptic('impactLight');
    switchTab(tabId);
    closeTabsView();
  };

  const handleCloseTab = (tabId: string) => {
    removeTab(tabId);
  };

  const handleNewTab = () => {
    triggerHaptic('impactLight');
    addTab('', 'New Tab');
    closeTabsView();
  };

  // Drag and drop handlers for tab reordering
  const handleLongPress = (index: number) => {
    triggerHaptic('impactHeavy');
    setDraggingIndex(index);
    // Scale up the dragged item
    Animated.spring(dragScale, {
      toValue: 1.05,
      useNativeDriver: true,
    }).start();
  };

  const handleDragMove = (
    index: number,
    gestureState: {dx: number; dy: number},
  ) => {
    if (draggingIndex === null) return;

    dragAnimatedValue.setValue({
      x: gestureState.dx,
      y: gestureState.dy,
    });

    // Calculate which tab we're hovering over
    const currentPos = tabPositions.current[draggingIndex];
    if (!currentPos) return;

    const newX = currentPos.x + gestureState.dx;
    const newY = currentPos.y + gestureState.dy;

    // Find the target index based on position
    let targetIndex = draggingIndex;
    for (let i = 0; i < tabPositions.current.length; i++) {
      const pos = tabPositions.current[i];
      if (
        newX >= pos.x - pos.width / 2 &&
        newX <= pos.x + pos.width * 1.5 &&
        newY >= pos.y - pos.height / 2 &&
        newY <= pos.y + pos.height * 1.5
      ) {
        targetIndex = i;
        break;
      }
    }

    if (targetIndex !== draggedOverIndex) {
      setDraggedOverIndex(targetIndex);
      if (targetIndex !== draggingIndex) {
        triggerHaptic('impactLight');
      }
    }
  };

  const handleDragEnd = () => {
    if (
      draggingIndex !== null &&
      draggedOverIndex !== null &&
      draggingIndex !== draggedOverIndex
    ) {
      reorderTabs(draggingIndex, draggedOverIndex);
      triggerHaptic('impactMedium');
    }

    // Reset animations
    Animated.parallel([
      Animated.spring(dragScale, {
        toValue: 1,
        useNativeDriver: true,
      }),
      Animated.spring(dragAnimatedValue, {
        toValue: {x: 0, y: 0},
        useNativeDriver: true,
      }),
    ]).start();

    setDraggingIndex(null);
    setDraggedOverIndex(null);
  };

  const createPanResponder = (index: number) => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: () => draggingIndex === index,
      onPanResponderMove: (_, gestureState) => {
        handleDragMove(index, gestureState);
      },
      onPanResponderRelease: () => {
        handleDragEnd();
      },
      onPanResponderTerminate: () => {
        handleDragEnd();
      },
    });
  };

  const handleTabLayout = (index: number, event: LayoutChangeEvent) => {
    const {x, y, width, height} = event.nativeEvent.layout;
    tabPositions.current[index] = {x, y, width, height};
  };

  const styles = StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    headerTint: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      // height: insets.top + 55,
      // backgroundColor: 'rgba(0, 0, 0, 0.26)',
      zIndex: 998,
    },
    // Safari-style loading progress bar
    progressBarContainer: {
      position: 'absolute',
      top: insets.top + 55 + 45 + 10, // 45 = ADDRESS_BAR_HEIGHT
      left: 0,
      right: 0,
      height: 2,
      backgroundColor: 'transparent',
      zIndex: 1000,
      overflow: 'hidden',
    },
    progressBar: {
      height: 2,
      backgroundColor: '#007AFF', // Safari blue
    },
    header: {
      position: 'absolute',
      top: insets.top + 53,
      left: 0,
      right: 0,
      zIndex: 999,
      paddingHorizontal: 12,
      paddingVertical: 2,
      // backgroundColor: 'red',
    },
    urlBar: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderRadius: 25,
      borderWidth: tokens.borderWidth.md,
      borderColor: theme.colors.foreground,
      paddingHorizontal: 14,
      height: 50,
    },
    urlInput: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.foreground,
      padding: 0,
    },
    iconButton: {
      padding: 4,
      marginLeft: 8,
    },
    tabsButton: {
      marginLeft: 8,
      width: 28,
      height: 24,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: theme.colors.foreground2,
      justifyContent: 'center',
      alignItems: 'center',
    },
    tabsCount: {
      fontSize: 12,
    },
    // Bottom navbar styles - pill shaped like main BottomNavigation
    bottomNavContainer: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 1000,
      paddingBottom: insets.bottom < 20 ? 10 : 0,
    },
    bottomNavPill: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      width: '90%',
      alignSelf: 'center',
      borderRadius: 50,
      height: 55,
      borderWidth: tokens.borderWidth.md,
      borderColor: theme.colors.muted,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: {width: 0, height: 4},
      backgroundColor: 'rgba(0, 0, 0, 0.35)',
      marginBottom: insets.bottom < 20 ? 10 : 25,
    },
    bottomNavPillFallback: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      width: '90%',
      alignSelf: 'center',
      borderRadius: 50,
      height: 55,
      borderWidth: tokens.borderWidth.md,
      borderColor: theme.colors.muted,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: {width: 0, height: 4},
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      marginBottom: insets.bottom < 20 ? 10 : 25,
    },
    bottomNavItem: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 8,
    },
    tabsButtonNav: {
      width: 28,
      height: 24,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: theme.colors.foreground2,
      justifyContent: 'center',
      alignItems: 'center',
    },
    tabsCountNav: {
      fontSize: 12,
      fontWeight: '700',
      color: theme.colors.foreground2,
    },
    autocompleteContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 10,
      marginTop: 8,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      overflow: 'hidden',
    },
    autocompleteItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.surfaceBorder,
    },
    autocompleteIcon: {
      marginRight: 10,
    },
    autocompleteTextContainer: {
      flex: 1,
    },
    autocompleteTitle: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.foreground,
      marginBottom: 2,
    },
    autocompleteUrl: {
      fontSize: 12,
      color: theme.colors.foreground3,
    },
    landingTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.foreground,
      marginHorizontal: 16,
      marginTop: 24,
      marginBottom: 16,
    },
    shoppingGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: 8,
    },
    shoppingButton: {
      alignItems: 'center',
      justifyContent: 'center',
      margin: 8,
      padding: 16,
      borderRadius: 12,
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.surfaceBorder,
      width: (screenWidth - 48) / 2,
    },
    shoppingButtonText: {
      color: theme.colors.foreground,
      fontSize: 14,
      fontWeight: '500',
      marginTop: 8,
    },
    addSiteTile: {
      borderStyle: 'dashed',
      borderWidth: 2,
      backgroundColor: 'transparent',
    },
    addSiteModalButton: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: 'center',
    },
    addSiteModalOverlay: {
      flex: 1,
      justifyContent: 'flex-end',
      backgroundColor: theme.colors.background,
    },
    addSiteModalContent: {
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingBottom: 40,
    },
    addSiteInputContainer: {
      marginBottom: 16,
    },
    addSiteInputLabel: {
      fontSize: 14,
      fontWeight: '500',
      marginBottom: 8,
    },
    addSiteInput: {
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      fontSize: 16,
      borderWidth: 1,
    },
    addSiteButtonRow: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 8,
    },
    addSiteButtonText: {
      fontSize: 16,
      fontWeight: '600',
      textAlign: 'center',
    },
    // Tabs View Overlay
    tabsOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.colors.background,
      zIndex: 1000,
    },
    tabsHeader: {
      paddingTop: insets.top + 4,
      paddingHorizontal: 16,
      paddingBottom: 6,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 60,
    },
    tabsHeaderTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.foreground,
    },
    tabsHeaderButton: {
      padding: 8,
    },
    tabsHeaderButtonText: {
      fontSize: 17,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    tabsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: 12,
      paddingTop: 4,
    },
    tabCardWrapper: {
      width: TAB_CARD_WIDTH,
      margin: 6,
      alignItems: 'center',
      marginBottom: 8,
    },
    tabCard: {
      width: TAB_CARD_WIDTH,
      height: TAB_CARD_HEIGHT,
      borderRadius: 15,
      backgroundColor: theme.colors.surface,
      overflow: 'hidden',
      // borderWidth: 2,
      // borderColor: 'transparent',
    },
    tabCardActive: {
      borderColor: theme.colors.primary,
    },
    tabCardDragging: {
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 8},
      shadowOpacity: 0.4,
      shadowRadius: 12,
      borderColor: theme.colors.primary,
    },
    tabCardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 10,
      paddingVertical: 8,
      backgroundColor: 'transparent',
    },
    tabCardTitle: {
      flex: 1,
      fontSize: 12,
      fontWeight: '600',
      color: '#fff',
    },
    tabCardClose: {
      padding: 2,
    },
    tabCardCloseButton: {
      position: 'absolute',
      top: 8,
      right: 8,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      borderRadius: 12,
      padding: 4,
    },
    tabCardTitleBelow: {
      width: TAB_CARD_WIDTH,
      fontSize: 12,
      fontWeight: '600',
      color: theme.colors.foreground,
      marginTop: 6,
      paddingHorizontal: 4,
    },
    tabCardContent: {
      flex: 1,
      backgroundColor: 'transparent',
      justifyContent: 'flex-end',
      alignItems: 'center',
      paddingBottom: 8,
    },
    tabCardDomain: {
      fontSize: 13,
      fontWeight: '500',
      color: 'rgba(255, 255, 255, 0.9)',
      marginTop: 0,
    },
    newTabCard: {
      width: TAB_CARD_WIDTH,
      height: TAB_CARD_HEIGHT,
      margin: 6,
      borderRadius: 12,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: theme.colors.surfaceBorder,
      borderStyle: 'dashed',
    },
    newTabText: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.foreground3,
      marginTop: 8,
    },
    bottomBar: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      paddingVertical: 12,
      paddingBottom: insets.bottom + 12,
      backgroundColor: theme.colors.surface,
      borderTopWidth: 1,
      borderTopColor: theme.colors.surfaceBorder,
    },
    // Save Menu Styles
    saveMenuOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    saveMenuContent: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingTop: 12,
      paddingBottom: insets.bottom + 20,
    },
    saveMenuHandle: {
      width: 36,
      height: 4,
      backgroundColor: theme.colors.foreground3,
      borderRadius: 2,
      alignSelf: 'center',
      marginBottom: 16,
    },
    saveMenuTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.foreground,
      paddingHorizontal: 20,
      marginBottom: 12,
    },
    saveMenuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 20,
    },
    saveMenuItemIcon: {
      width: 40,
      height: 40,
      borderRadius: 10,
      backgroundColor: theme.colors.background,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    saveMenuItemText: {
      flex: 1,
      fontSize: 16,
      color: theme.colors.foreground,
    },
    saveMenuItemCheck: {
      marginLeft: 8,
    },
    collectionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 20,
    },
    collectionColor: {
      width: 32,
      height: 32,
      borderRadius: 8,
      marginRight: 12,
      justifyContent: 'center',
      alignItems: 'center',
    },
    collectionName: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.foreground,
    },
    collectionCount: {
      fontSize: 13,
      color: theme.colors.foreground3,
    },
    // Bookmarks Modal Styles
    bookmarksModalContainer: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    bookmarksModalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 8,
      marginTop: 60,
    },
    bookmarksCloseButton: {
      padding: 8,
    },
    bookmarksMenuButton: {
      padding: 8,
    },
    bookmarksSearchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderRadius: 10,
      marginHorizontal: 16,
      marginBottom: 16,
      paddingHorizontal: 12,
      height: 40,
    },
    bookmarksSearchIcon: {
      marginRight: 8,
    },
    bookmarksSearchInput: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.foreground,
      padding: 0,
    },
    bookmarksSearchMic: {
      marginLeft: 8,
    },
    bookmarksModalContent: {
      flex: 1,
    },
    // Recently Saved Section
    recentlySavedSection: {
      marginBottom: 24,
    },
    sectionHeaderText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.foreground,
      paddingHorizontal: 16,
      marginBottom: 12,
    },
    recentlySavedScroll: {
      paddingLeft: 16,
    },
    recentlySavedCard: {
      width: 160,
      marginRight: 12,
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 12,
    },
    recentlySavedPreview: {
      width: '100%',
      height: 100,
      backgroundColor: theme.colors.background,
      borderRadius: 8,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 8,
    },
    recentlySavedTitle: {
      fontSize: 13,
      fontWeight: '500',
      color: theme.colors.foreground,
      marginBottom: 4,
    },
    recentlySavedUrl: {
      fontSize: 11,
      color: theme.colors.foreground3,
      marginBottom: 6,
    },
    recentlySavedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.background,
      alignSelf: 'flex-start',
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    recentlySavedBadgeText: {
      fontSize: 9,
      color: theme.colors.foreground3,
      marginLeft: 2,
    },
    // Folders Section
    foldersSection: {
      marginBottom: 24,
    },
    folderItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      backgroundColor: theme.colors.surface,
    },
    folderIcon: {
      width: 32,
      height: 32,
      borderRadius: 8,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    folderName: {
      flex: 1,
      fontSize: 15,
      fontWeight: '500',
      color: theme.colors.foreground,
    },
    folderCount: {
      fontSize: 14,
      color: theme.colors.foreground3,
      marginRight: 8,
    },
    // Bookmarks Section
    bookmarksSection: {
      marginBottom: 24,
    },
    bookmarkListItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 16,
      backgroundColor: theme.colors.surface,
    },
    bookmarkListIcon: {
      width: 24,
      height: 24,
      borderRadius: 6,
      backgroundColor: theme.colors.background,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    bookmarkListTitle: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.foreground,
    },
    // Empty State
    bookmarksEmptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 60,
    },
    bookmarksEmptyText: {
      fontSize: 16,
      color: theme.colors.foreground3,
      marginTop: 16,
    },
    // Tab Bar
    bookmarksTabBar: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      paddingVertical: 12,
      paddingBottom: insets.bottom + 12,
      backgroundColor: theme.colors.surface,
      borderTopWidth: 1,
      borderTopColor: theme.colors.surfaceBorder,
    },
    bookmarksTab: {
      padding: 8,
    },
    // Legacy styles (for compatibility)
    bookmarkModalItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.surfaceBorder,
    },
    bookmarkModalIcon: {
      width: 36,
      height: 36,
      borderRadius: 8,
      backgroundColor: theme.colors.background,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    bookmarkModalInfo: {
      flex: 1,
      marginRight: 8,
    },
    bookmarkModalTitle: {
      fontSize: 15,
      fontWeight: '500',
      color: theme.colors.foreground,
      marginBottom: 4,
    },
    bookmarkModalUrl: {
      fontSize: 13,
      color: theme.colors.foreground3,
    },
    // Tab Card Preview Image
    tabCardPreview: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: '100%',
      height: '100%',
      resizeMode: 'cover',
    },
    tabCardPreviewContainer: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: '100%',
      height: '100%',
      justifyContent: 'center',
      alignItems: 'center',
      overflow: 'hidden',
    },
    tabCardScreenshot: {
      width: '100%',
      height: '100%',
      resizeMode: 'cover',
    },
    tabCardPlaceholder: {
      position: 'absolute',
      width: '100%',
      height: '100%',
      top: 0,
      left: 0,
    },
    tabCardFavicon: {
      width: 64,
      height: 64,
      borderRadius: 8,
    },
    tabCardOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
      justifyContent: 'space-between',
      padding: 0,
    },
    // DEBUG: Price Extraction Panel
    debugPanel: {
      position: 'absolute',
      bottom: insets.bottom + 80,
      left: 16,
      right: 16,
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 12,
      borderWidth: 2,
      borderColor: theme.colors.primary,
      shadowColor: '#000',
      shadowOffset: {width: 0, height: 2},
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 5,
      zIndex: 1000,
    },
    debugTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: theme.colors.primary,
      marginBottom: 8,
    },
    debugText: {
      fontSize: 12,
      color: theme.colors.foreground2,
      marginBottom: 4,
      fontFamily: 'Menlo',
    },
    debugDismiss: {
      fontSize: 12,
      color: theme.colors.primary,
      marginTop: 8,
      fontWeight: '600',
      textAlign: 'center',
    },
    debugHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    debugToggle: {
      fontSize: 14,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    debugDetail: {
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: theme.colors.surfaceBorder,
    },
    debugDetailTitle: {
      fontSize: 11,
      fontWeight: '600',
      color: theme.colors.primary,
      marginTop: 6,
      marginBottom: 2,
    },
    debugDetailText: {
      fontSize: 10,
      color: theme.colors.foreground3,
      fontFamily: 'Menlo',
      lineHeight: 14,
    },
  });

  const showLanding = !currentTab || !currentTab.url;

  // 🔥 VOICE ADD
  const handleMicPressIn = async () => {
    const ok = await prepareAudio();
    if (!ok) return;
    ReactNativeHapticFeedback.trigger('impactLight');
    setIsHoldingMic(true);
    startListening();
  };

  // Ref to track if we should auto-submit after voice input
  const shouldAutoSubmitVoice = useRef(false);
  const wasRecording = useRef(false);

  const handleMicPressOut = () => {
    setIsHoldingMic(false);
    stopListening();
    ReactNativeHapticFeedback.trigger('selection');
    // Flag to auto-submit after voice input ends (WebBrowser address bar only)
    shouldAutoSubmitVoice.current = true;
  };

  // Auto-submit when recording stops after mic release (voice input only)
  useEffect(() => {
    // Detect transition from recording to not recording
    if (wasRecording.current && !isRecording && shouldAutoSubmitVoice.current) {
      shouldAutoSubmitVoice.current = false;
      // Delay to ensure inputValue is updated from speech, then submit
      setTimeout(() => {
        handleSubmit();
      }, 400);
    }
    wasRecording.current = isRecording;
  }, [isRecording]); // Only trigger on recording state change, not inputValue

  // Calculate address bar header height for content padding (like HomeScreen's HEADER_HEIGHT)
  const ADDRESS_BAR_HEIGHT = 45; // urlBar height (40) + paddingBottom (12)

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      {/* Full-screen scrollable content - exactly like HomeScreen */}
      {showLanding ? (
        <ScrollView
          contentContainerStyle={{
            paddingTop: insets.top + 55 + ADDRESS_BAR_HEIGHT, // space for global header + address bar
            paddingBottom: insets.bottom + 90, // space for bottom nav
            minHeight: '100%',
          }}
          scrollEventThrottle={16}
          onScroll={event => {
            const y = event.nativeEvent.contentOffset.y;
            const diff = y - lastNavScrollY.current;

            // Scrolling down - hide nav
            if (
              diff > SCROLL_THRESHOLD &&
              !isBottomNavHidden.current &&
              y > 10
            ) {
              isBottomNavHidden.current = true;
              Animated.timing(bottomNavTranslateY, {
                toValue: NAV_HEIGHT + insets.bottom,
                duration: 300,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
              }).start();
            }
            // Scrolling up - show nav
            else if (diff < -SCROLL_THRESHOLD && isBottomNavHidden.current) {
              isBottomNavHidden.current = false;
              Animated.timing(bottomNavTranslateY, {
                toValue: 0,
                duration: 300,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
              }).start();
            }

            lastNavScrollY.current = y;
          }}
          showsVerticalScrollIndicator={false}>
          <Text style={styles.landingTitle}>Quick Brands Shortcuts</Text>
          <View style={styles.shoppingGrid}>
            {quickShopSites.map(site => (
              <TouchableOpacity
                key={site.id}
                style={styles.shoppingButton}
                onPress={() => handleQuickShop(site.url)}
                onLongPress={() => {
                  triggerHaptic('impactMedium');
                  Alert.alert(
                    'Remove Site',
                    `Remove "${site.name}" from quick shops?`,
                    [
                      {text: 'Cancel', style: 'cancel'},
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () => removeQuickShopSite(site.id),
                      },
                    ],
                  );
                }}>
                <MaterialIcons
                  name="shopping-bag"
                  size={28}
                  color={theme.colors.primary}
                />
                <Text style={styles.shoppingButtonText}>{site.name}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity
              style={[styles.shoppingButton, styles.addSiteTile]}
              onPress={() => {
                triggerHaptic('impactLight');
                setShowAddSiteModal(true);
              }}>
              <MaterialIcons
                name="add"
                size={28}
                color={theme.colors.primary}
              />
              <Text style={styles.shoppingButtonText}>Add Site</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      ) : (
        <View
          ref={containerRef}
          style={{
            flex: 1,
            marginTop: insets.top + 55 + ADDRESS_BAR_HEIGHT + 12,
          }}
          collapsable={false}>
          <WebView
            ref={webRef}
            source={{uri: currentTab?.url || ''}}
            style={{flex: 1}}
            // === DEBUGGING ===
            webviewDebuggingEnabled={__DEV__}
            // === GEOLOCATION ===
            geolocationEnabled={true}
            injectedJavaScriptBeforeContentLoaded={`
              (function() {
                console.log('[StylIQ Geolocation] Injecting geolocation override...');

                // Store callbacks for geolocation requests
                window.__geolocationCallbacks = {};
                var callbackCounter = 0;

                // Check if navigator.geolocation exists
                if (!navigator.geolocation) {
                  console.log('[StylIQ Geolocation] navigator.geolocation not available');
                  return;
                }

                // Override navigator.geolocation.getCurrentPosition
                var originalGetCurrentPosition = navigator.geolocation.getCurrentPosition;
                navigator.geolocation.getCurrentPosition = function(success, error, options) {
                  console.log('[StylIQ Geolocation] getCurrentPosition called');
                  var callbackId = 'geo_' + (++callbackCounter) + '_' + Date.now();
                  window.__geolocationCallbacks[callbackId] = { success: success, error: error };

                  if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
                    console.log('[StylIQ Geolocation] Sending request to React Native, callbackId:', callbackId);
                    window.ReactNativeWebView.postMessage(JSON.stringify({
                      type: 'geolocationRequest',
                      callbackId: callbackId,
                      options: options || {}
                    }));
                  } else {
                    console.log('[StylIQ Geolocation] ReactNativeWebView not available, falling back');
                    if (originalGetCurrentPosition) {
                      originalGetCurrentPosition.call(navigator.geolocation, success, error, options);
                    }
                  }
                };

                // Override navigator.geolocation.watchPosition
                var originalWatchPosition = navigator.geolocation.watchPosition;
                navigator.geolocation.watchPosition = function(success, error, options) {
                  console.log('[StylIQ Geolocation] watchPosition called');
                  navigator.geolocation.getCurrentPosition(success, error, options);
                  return callbackCounter;
                };

                console.log('[StylIQ Geolocation] Override complete');
                true;
              })();
            `}
            // === SECURITY: Apply secure defaults ===
            {...SECURE_WEBVIEW_DEFAULTS}
            // Allow HTTP for compatibility with some fashion sites, and about: for iframes
            originWhitelist={['https://*', 'http://*', 'about:*']}
            onShouldStartLoadWithRequest={request => {
              // Check if auth flow is active - pause navigation during Face ID
              if (isKeychainAuthActiveRef.current) {
                // Store pending navigation to resume after auth completes
                pendingNavigationRef.current = request.url;
                // console.log('[Keychain] Navigation paused during auth flow:', request.url);
                // Allow the request but track it
              }
              // Delegate to standard security handler
              return createOnShouldStartLoadWithRequest({allowHttp: true})(
                request,
              );
            }}
            onContentProcessDidTerminate={createCrashRecoveryHandler(webRef)}
            // === iOS KEYCHAIN AUTOFILL: Conditional cookie sharing ===
            // Only enable cookie sharing for auth-related pages (SSO, login paths, OAuth flows)
            // This maintains privacy isolation for regular browsing while enabling
            // reliable Keychain password autofill on login pages.
            // See keychainCookiePolicy.ts for domain classification logic.
            sharedCookiesEnabled={shouldShareCookiesForUrl(
              currentTab?.url || '',
            )}
            // === END SECURITY ===
            contentInset={{
              bottom: insets.bottom + 90,
            }}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
            // 👇 Inertia / momentum scrolling
            decelerationRate="normal" // gives Safari-style glide
            bounces={true} // iOS bounce effect
            scrollEnabled={true} // ensure scroll isn't locked
            showsVerticalScrollIndicator={false}
            showsHorizontalScrollIndicator={false}
            overScrollMode="never" // keeps Android smooth too
            androidLayerType="hardware" // helps performance
            onNavigationStateChange={navState => {
              // Debounce navigation state changes to prevent rapid URL toggling
              if (!navState.url || !currentTab) return;

              // Skip if same URL (ignore www/trailing slash differences)
              if (
                isSameUrl(navState.url, currentTab.url) &&
                isSameUrl(navState.url, lastNavUrlRef.current)
              ) {
                return;
              }

              // Clear any pending debounce
              if (navStateDebounceRef.current) {
                clearTimeout(navStateDebounceRef.current);
              }

              // Store the latest URL
              lastNavUrlRef.current = navState.url;

              // Debounce the update - only apply after URL is stable for 300ms
              navStateDebounceRef.current = setTimeout(() => {
                // Double-check the URL is still the same after debounce
                if (
                  navState.url === lastNavUrlRef.current &&
                  !isSameUrl(navState.url, currentTab.url)
                ) {
                  updateTab(
                    currentTab.id,
                    navState.url,
                    navState.title || currentTab.title,
                  );
                  setInputValue(navState.url);

                  // Track navigation history for back/forward (skip if this is a history navigation)
                  if (!isNavHistoryNavigation.current) {
                    updateTabNavHistory(currentTab.id, navState.url);
                  }
                  isNavHistoryNavigation.current = false;

                  // Track visit history with brand
                  // SECURITY: Sanitize URL to strip sensitive query params before analytics
                  const sanitizedUrl = sanitizeUrlForAnalytics(navState.url);
                  const safeTitle = sanitizeTitle(navState.title, 200);
                  const navBrand = shoppingAnalytics.extractBrand(
                    safeTitle,
                    sanitizedUrl,
                  );
                  addToHistory(
                    sanitizedUrl,
                    safeTitle || getDomain(sanitizedUrl),
                    getDomain(sanitizedUrl),
                    navBrand,
                  );
                }
              }, 300);
            }}
            onScroll={handleWebViewScroll}
            onLoadStart={() => {
              setIsLoading(true);
              setLoadProgress(0);
              // Animate progress bar appearance
              progressAnimValue.setValue(0);
            }}
            onLoadProgress={({nativeEvent}) => {
              const progress = nativeEvent.progress;
              setLoadProgress(progress);
              // Animate to current progress
              Animated.timing(progressAnimValue, {
                toValue: progress,
                duration: 100,
                useNativeDriver: false,
              }).start();
            }}
            onLoadEnd={() => {
              // Complete the progress animation then hide
              Animated.timing(progressAnimValue, {
                toValue: 1,
                duration: 100,
                useNativeDriver: false,
              }).start(() => {
                // Small delay before hiding to show completion
                setTimeout(() => {
                  setIsLoading(false);
                  setLoadProgress(0);
                  progressAnimValue.setValue(0);
                }, 150);
              });
              // Call existing load end handler
              handleWebViewLoadEnd();
            }}
            onMessage={handleWebViewMessage}
            userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
            pullToRefreshEnabled={true}
            allowsBackForwardNavigationGestures={true}
          />
        </View>
      )}

      {/* Safari-style loading progress bar */}
      {isLoading && !showTabsView && currentTab?.url && (
        <View style={styles.progressBarContainer}>
          <Animated.View
            style={[
              styles.progressBar,
              {
                width: progressAnimValue.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', '100%'],
                }),
              },
            ]}
          />
        </View>
      )}

      {/* Light tint overlay for global header area */}
      <View style={styles.headerTint} pointerEvents="none" />

      {/* Floating Address Bar Header - renders after content to appear on top */}
      <View style={styles.header}>
        <View style={styles.urlBar}>
          <TextInput
            style={styles.urlInput}
            value={inputValue}
            onChangeText={text => {
              setInputValue(text);
              setShowAutocomplete(text.length > 0);
            }}
            onSubmitEditing={handleSubmit}
            onFocus={() => {
              triggerHaptic('impactLight');
              setIsInputFocused(true);
              setShowAutocomplete(inputValue.length > 0);
            }}
            onBlur={() => {
              setTimeout(() => {
                setIsInputFocused(false);
                setShowAutocomplete(false);
              }, 150);
            }}
            placeholder="Search or enter URL"
            placeholderTextColor={theme.colors.foreground3}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="ascii-capable"
            returnKeyType="go"
            selectTextOnFocus
          />
          {inputValue.length > 0 && (
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => {
                triggerHaptic('impactLight');
                setInputValue('');
              }}>
              <MaterialIcons
                name="close"
                size={18}
                color={theme.colors.foreground3}
              />
            </TouchableOpacity>
          )}

          {/* Refresh button */}
          {currentTab?.url && (
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => {
                triggerHaptic('impactLight');
                webRef.current?.reload();
              }}>
              <MaterialIcons
                name="refresh"
                size={22}
                color={theme.colors.foreground3}
              />
            </TouchableOpacity>
          )}

          {/* 🔥 VOICE ADD – Mic button */}
          {/* <TouchableOpacity
            onPressIn={handleMicPressIn}
            onPressOut={handleMicPressOut}
            style={styles.iconButton}>
            <MaterialIcons
              name={isRecording ? 'mic' : 'mic-none'}
              size={22}
              color={
                isRecording ? theme.colors.primary : theme.colors.foreground3
              }
            />
          </TouchableOpacity> */}
        </View>
        {showAutocomplete && autocompleteSuggestions.length > 0 && (
          <View style={styles.autocompleteContainer}>
            {autocompleteSuggestions.map((item, index) => (
              <TouchableOpacity
                key={`${item.url}-${index}`}
                style={styles.autocompleteItem}
                onPress={() => handleAutocompleteSelect(item.url)}>
                <MaterialIcons
                  name="history"
                  size={18}
                  color={theme.colors.foreground3}
                  style={styles.autocompleteIcon}
                />
                <View style={styles.autocompleteTextContainer}>
                  <Text
                    style={styles.autocompleteTitle}
                    numberOfLines={1}
                    ellipsizeMode="tail">
                    {item.title || getDomain(item.url)}
                  </Text>
                  <Text
                    style={styles.autocompleteUrl}
                    numberOfLines={1}
                    ellipsizeMode="middle">
                    {item.url}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Browsers Bottom Navbar - Pill shaped with hide on scroll */}
      {!showTabsView && (
        <Animated.View
          style={[
            styles.bottomNavContainer,
            {transform: [{translateY: bottomNavTranslateY}]},
          ]}>
          {isLiquidGlassSupported ? (
            <LiquidGlassView
              style={styles.bottomNavPill}
              effect="clear"
              tintColor="rgba(0, 0, 0, 0.48)"
              colorScheme="system">
              <AppleTouchFeedback
                onPress={() => navigate('Home')}
                hapticStyle="impactLight"
                style={{
                  padding: moderateScale(tokens.spacing.xxs),
                  marginLeft: moderateScale(tokens.spacing.xsm),
                }}>
                <Icon name="home" size={26} color={theme.colors.buttonText1} />
              </AppleTouchFeedback>
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={() => {
                  triggerHaptic('impactLight');
                  if (currentTab) {
                    const url = navigateTabBack(currentTab.id);
                    if (url) {
                      isNavHistoryNavigation.current = true;
                      webRef.current?.injectJavaScript(
                        `window.location.href = ${JSON.stringify(url)}; true;`,
                      );
                    }
                  }
                }}
                disabled={!currentTab || !getTabCanGoBack(currentTab.id)}>
                <MaterialIcons
                  name="arrow-back-ios"
                  size={22}
                  color={
                    currentTab && getTabCanGoBack(currentTab.id)
                      ? theme.colors.buttonText1
                      : theme.colors.buttonText1
                  }
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={() => {
                  triggerHaptic('impactLight');
                  if (currentTab) {
                    const url = navigateTabForward(currentTab.id);
                    if (url) {
                      isNavHistoryNavigation.current = true;
                      webRef.current?.injectJavaScript(
                        `window.location.href = ${JSON.stringify(url)}; true;`,
                      );
                    }
                  }
                }}
                disabled={!currentTab || !getTabCanGoForward(currentTab.id)}>
                <MaterialIcons
                  name="arrow-forward-ios"
                  size={22}
                  color={
                    currentTab && getTabCanGoForward(currentTab.id)
                      ? theme.colors.buttonText1
                      : theme.colors.buttonText1
                  }
                />
              </TouchableOpacity>
              {/* Bookmark button - commented out
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={handleAddToBookmarks}>
                <MaterialIcons
                  name={bookmarked ? 'bookmark' : 'bookmark-border'}
                  size={24}
                  color={
                    bookmarked ? theme.colors.button1 : theme.colors.buttonText1
                  }
                />
              </TouchableOpacity>
              */}
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={handleShareButtonPress}>
                <MaterialIcons
                  name="ios-share"
                  size={24}
                  color={theme.colors.buttonText1}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={openTabsView}>
                <View
                  style={[
                    styles.tabsButtonNav,
                    {borderColor: theme.colors.buttonText1},
                  ]}>
                  <Text
                    style={
                      (styles.tabsCountNav, {color: theme.colors.buttonText1})
                    }>
                    {tabs.filter(t => t.url).length || 1}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={handleSaveMenuOpen}>
                <MaterialIcons
                  name="add-circle-outline"
                  size={28}
                  color={theme.colors.buttonText1}
                />
              </TouchableOpacity>
            </LiquidGlassView>
          ) : (
            <View style={styles.bottomNavPillFallback}>
              <AppleTouchFeedback
                onPress={() => navigate('Home')}
                hapticStyle="impactLight"
                style={{
                  padding: moderateScale(tokens.spacing.xxs),
                  marginLeft: moderateScale(tokens.spacing.xsm),
                }}>
                <Icon name="home" size={26} color={theme.colors.buttonText1} />
              </AppleTouchFeedback>
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={() => {
                  triggerHaptic('impactLight');
                  if (currentTab) {
                    const url = navigateTabBack(currentTab.id);
                    if (url) {
                      isNavHistoryNavigation.current = true;
                      webRef.current?.injectJavaScript(
                        `window.location.href = ${JSON.stringify(url)}; true;`,
                      );
                    }
                  }
                }}
                disabled={!currentTab || !getTabCanGoBack(currentTab.id)}>
                <MaterialIcons
                  name="arrow-back-ios"
                  size={22}
                  color={
                    currentTab && getTabCanGoBack(currentTab.id)
                      ? theme.colors.buttonText1
                      : theme.colors.buttonText1
                  }
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={() => {
                  triggerHaptic('impactLight');
                  if (currentTab) {
                    const url = navigateTabForward(currentTab.id);
                    if (url) {
                      isNavHistoryNavigation.current = true;
                      webRef.current?.injectJavaScript(
                        `window.location.href = ${JSON.stringify(url)}; true;`,
                      );
                    }
                  }
                }}
                disabled={!currentTab || !getTabCanGoForward(currentTab.id)}>
                <MaterialIcons
                  name="arrow-forward-ios"
                  size={22}
                  color={
                    currentTab && getTabCanGoForward(currentTab.id)
                      ? theme.colors.buttonText1
                      : theme.colors.buttonText1
                  }
                />
              </TouchableOpacity>
              {/* Bookmark button - commented out
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={handleAddToBookmarks}>
                <MaterialIcons
                  name={bookmarked ? 'bookmark' : 'bookmark-border'}
                  size={24}
                  color={
                    bookmarked ? theme.colors.button1 : theme.colors.buttonText1
                  }
                />
              </TouchableOpacity>
              */}
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={handleShareButtonPress}>
                <MaterialIcons
                  name="ios-share"
                  size={24}
                  color={theme.colors.buttonText1}
                />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={openTabsView}>
                <View
                  style={[
                    styles.tabsButtonNav,
                    {borderColor: theme.colors.buttonText1},
                  ]}>
                  <Text
                    style={[
                      styles.tabsCountNav,
                      {color: theme.colors.buttonText1},
                    ]}>
                    {tabs.filter(t => t.url).length || 1}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.bottomNavItem}
                onPress={handleSaveMenuOpen}>
                <MaterialIcons
                  name="add-circle-outline"
                  size={28}
                  color={theme.colors.buttonText1}
                />
              </TouchableOpacity>
            </View>
          )}
        </Animated.View>
      )}

      {/* Shopping Assistant */}
      {!showTabsView && (
        <ShoppingAssistant
          onSuggestionPress={url => {
            if (currentTab) {
              updateTab(currentTab.id, url, currentTab.title);
            } else {
              addTab(url, 'New Tab');
            }
          }}
          isVisible={!showTabsView}
          userId={userId}
          aiSuggestions={aiShoppingAssistantSuggestions}
        />
      )}

      {/* Safari-style Tabs View */}
      {showTabsView && (
        <TouchableOpacity
          activeOpacity={1}
          onPress={closeTabsView}
          style={styles.tabsOverlay}>
          <Animated.View
            style={[
              {flex: 1},
              {
                opacity: tabsViewScale,
                transform: [
                  {
                    scale: tabsViewScale.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.9, 1],
                    }),
                  },
                ],
              },
            ]}>
            <TouchableOpacity
              activeOpacity={1}
              onPress={e => e.stopPropagation()}>
              <View style={styles.tabsHeader}>
                {/* <TouchableOpacity
                  style={styles.tabsHeaderButton}
                  onPress={handleNewTab}>
                  <Text style={styles.tabsHeaderButtonText}>+</Text>
                </TouchableOpacity> */}
                <Text style={styles.tabsHeaderTitle}>
                  {tabs.filter(t => t.url).length} Tabs
                </Text>
                <TouchableOpacity
                  style={styles.tabsHeaderButton}
                  onPress={() => {
                    triggerHaptic('impactLight');
                    closeTabsView();
                  }}>
                  <Text style={styles.tabsHeaderButtonText}>Done</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>

            <ScrollView
              contentContainerStyle={styles.tabsGrid}
              scrollEnabled={draggingIndex === null}>
              <TouchableOpacity
                style={styles.newTabCard}
                onPress={handleNewTab}>
                <MaterialIcons
                  name="add"
                  size={32}
                  color={theme.colors.foreground3}
                />
                <Text style={styles.newTabText}>New Tab</Text>
              </TouchableOpacity>
              {tabs
                .filter(tab => tab.url)
                .map((tab, index) => {
                  const isDragging = draggingIndex === index;
                  const isDropTarget =
                    draggedOverIndex === index && draggingIndex !== index;
                  const panResponder = createPanResponder(index);

                  return (
                    <SwipeableCard
                      key={tab.id}
                      onSwipeLeft={() => handleCloseTab(tab.id)}
                      style={styles.tabCardWrapper}>
                      <Animated.View
                        onLayout={e => handleTabLayout(index, e)}
                        style={[
                          isDragging && {
                            transform: [
                              {translateX: dragAnimatedValue.x},
                              {translateY: dragAnimatedValue.y},
                              {scale: dragScale},
                            ],
                            zIndex: 1000,
                            elevation: 10,
                          },
                          isDropTarget && {
                            opacity: 0.5,
                          },
                        ]}
                        {...panResponder.panHandlers}>
                        <TouchableOpacity
                          style={[
                            styles.tabCard,
                            tab.id === currentTabId && styles.tabCardActive,
                            isDragging && styles.tabCardDragging,
                          ]}
                          onPress={() => handleSelectTab(tab.id)}
                          onLongPress={() => handleLongPress(index)}
                          delayLongPress={300}
                          activeOpacity={0.8}>
                          {/* Tab Preview Background */}
                          <View style={styles.tabCardPreviewContainer}>
                            {tab.screenshot ? (
                              <Image
                                source={{uri: tab.screenshot}}
                                style={styles.tabCardScreenshot}
                                resizeMode="cover"
                              />
                            ) : (
                              <>
                                {/* Gradient/colored background when no screenshot */}
                                <View
                                  style={[
                                    styles.tabCardPlaceholder,
                                    {backgroundColor: theme.colors.surface},
                                  ]}
                                />
                                <Image
                                  source={{
                                    uri: `https://icons.duckduckgo.com/ip3/${getDomain(
                                      tab.url,
                                    )}.ico`,
                                  }}
                                  style={styles.tabCardFavicon}
                                  defaultSource={require('../assets/images/desktop-2.jpg')}
                                />
                              </>
                            )}
                          </View>

                          {/* Close button overlay */}
                          <TouchableOpacity
                            style={styles.tabCardCloseButton}
                            onPress={() => handleCloseTab(tab.id)}
                            hitSlop={{
                              top: 10,
                              bottom: 10,
                              left: 10,
                              right: 10,
                            }}>
                            <MaterialIcons
                              name="close"
                              size={16}
                              color="#fff"
                            />
                          </TouchableOpacity>
                        </TouchableOpacity>
                        {/* Title below the card */}
                        <Text
                          style={styles.tabCardTitleBelow}
                          numberOfLines={1}
                          ellipsizeMode="tail">
                          {tab.title || getDomain(tab.url)}
                        </Text>
                      </Animated.View>
                    </SwipeableCard>
                  );
                })}
            </ScrollView>
          </Animated.View>
        </TouchableOpacity>
      )}

      {/* Share Menu Modal */}
      <Modal
        visible={showShareMenu}
        transparent
        animationType="slide"
        onRequestClose={() => setShowShareMenu(false)}>
        <TouchableOpacity
          style={styles.saveMenuOverlay}
          activeOpacity={1}
          onPress={() => setShowShareMenu(false)}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={e => e.stopPropagation()}
            style={styles.saveMenuContent}>
            <View style={styles.saveMenuHandle} />
            <Text style={styles.saveMenuTitle}>Share</Text>
            {/* Save to My Notes */}
            <TouchableOpacity
              style={styles.saveMenuItem}
              onPress={handleShareToNotes}>
              <View style={styles.saveMenuItemIcon}>
                <MaterialIcons name="note-add" size={22} color="#10b981" />
              </View>
              <Text style={styles.saveMenuItemText}>Save to My Notes</Text>
              <MaterialIcons
                name="arrow-forward-ios"
                size={16}
                color={theme.colors.foreground3}
                style={styles.saveMenuItemCheck}
              />
            </TouchableOpacity>
            {/* Share via iOS */}
            <TouchableOpacity style={styles.saveMenuItem} onPress={handleShare}>
              <View style={styles.saveMenuItemIcon}>
                <MaterialIcons name="ios-share" size={22} color="#3b82f6" />
              </View>
              <Text style={styles.saveMenuItemText}>Share via...</Text>
              <MaterialIcons
                name="arrow-forward-ios"
                size={16}
                color={theme.colors.foreground3}
                style={styles.saveMenuItemCheck}
              />
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Image Save Modal */}
      <Modal
        visible={showImageSaveModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowImageSaveModal(false)}>
        <TouchableOpacity
          style={styles.saveMenuOverlay}
          activeOpacity={1}
          onPress={() => setShowImageSaveModal(false)}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={e => e.stopPropagation()}
            style={styles.saveMenuContent}>
            <View style={styles.saveMenuHandle} />
            <Text style={styles.saveMenuTitle}>Save Image</Text>

            {/* Save to Inspired Looks */}
            <TouchableOpacity
              style={styles.saveMenuItem}
              onPress={async () => {
                if (longPressedImageUrl && userId) {
                  setShowImageSaveModal(false);
                  try {
                    const accessToken = await getAccessToken();
                    const response = await fetch(
                      `${API_BASE_URL}/saved-looks`,
                      {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          Authorization: `Bearer ${accessToken}`,
                        },
                        body: JSON.stringify({
                          user_id: userId,
                          image_url: longPressedImageUrl,
                          name: 'Web Inspiration',
                        }),
                      },
                    );
                    if (response.ok) {
                      triggerHaptic('notificationSuccess');
                      Alert.alert('Saved', 'Image saved to Inspired Looks');
                    } else {
                      const errorText = await response.text();
                      console.log(
                        'Save to Inspired Looks failed:',
                        response.status,
                        errorText,
                      );
                      triggerHaptic('notificationError');
                      Alert.alert(
                        'Error',
                        'Failed to save image. Please try again.',
                      );
                    }
                  } catch (error) {
                    console.log('Save to Inspired Looks error:', error);
                    triggerHaptic('notificationError');
                    Alert.alert(
                      'Error',
                      'Network error. Please check your connection.',
                    );
                  }
                } else {
                  setShowImageSaveModal(false);
                  if (!userId) {
                    Alert.alert(
                      'Sign In Required',
                      'Please sign in to save to Inspired Looks.',
                    );
                  }
                }
              }}>
              <View style={styles.saveMenuItemIcon}>
                <MaterialIcons name="auto-awesome" size={22} color="#f59e0b" />
              </View>
              <Text style={styles.saveMenuItemText}>
                Save to Inspired Styles
              </Text>
              <MaterialIcons
                name="arrow-forward-ios"
                size={16}
                color={theme.colors.foreground3}
                style={styles.saveMenuItemCheck}
              />
            </TouchableOpacity>

                        {/* Save to Photos */}
            <TouchableOpacity
              style={styles.saveMenuItem}
              onPress={async () => {
                if (longPressedImageUrl) {
                  setShowImageSaveModal(false);
                  try {
                    await ImageSaverModule.saveImageFromUrl(
                      longPressedImageUrl,
                    );
                    triggerHaptic('notificationSuccess');
                  } catch (error) {
                    console.log('Image save error:', error);
                    triggerHaptic('notificationError');
                  }
                } else {
                  setShowImageSaveModal(false);
                }
              }}>
              <View style={styles.saveMenuItemIcon}>
                <MaterialIcons name="photo-library" size={22} color="#10b981" />
              </View>
              <Text style={styles.saveMenuItemText}>Save to Photos</Text>
              <MaterialIcons
                name="arrow-forward-ios"
                size={16}
                color={theme.colors.foreground3}
                style={styles.saveMenuItemCheck}
              />
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* iOS Password AutoFill - passwords are managed by iOS/iCloud Keychain automatically */}
      {/* No custom password save modal needed - iOS handles password saving via system prompts */}

      {/* Save Menu Modal */}
      <Modal
        visible={showSaveMenu}
        transparent
        animationType="slide"
        onRequestClose={() => setShowSaveMenu(false)}>
        <TouchableOpacity
          style={styles.saveMenuOverlay}
          activeOpacity={1}
          onPress={() => {
            setShowSaveMenu(false);
            setShowCollectionPicker(false);
          }}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={e => e.stopPropagation()}
            style={styles.saveMenuContent}>
            <View style={styles.saveMenuHandle} />
            <Text style={styles.saveMenuTitle}>Save Page</Text>

            {/* Add to Bookmarks */}
            <TouchableOpacity
              style={styles.saveMenuItem}
              onPress={handleAddToBookmarks}>
              <View style={styles.saveMenuItemIcon}>
                <MaterialIcons
                  name="bookmark"
                  size={22}
                  color={theme.colors.primary}
                />
              </View>
              <Text style={styles.saveMenuItemText}>
                {bookmarked ? 'Remove from Bookmarks' : 'Add to Bookmarks'}
              </Text>
              {bookmarked && (
                <MaterialIcons
                  name="check"
                  size={20}
                  color={theme.colors.primary}
                  style={styles.saveMenuItemCheck}
                />
              )}
            </TouchableOpacity>

            {/* Add to Collection */}
            <TouchableOpacity
              style={styles.saveMenuItem}
              onPress={() => setShowCollectionPicker(!showCollectionPicker)}>
              <View style={styles.saveMenuItemIcon}>
                <MaterialIcons
                  name="folder-special"
                  size={22}
                  color={theme.colors.secondary || '#f59e0b'}
                />
              </View>
              <Text style={styles.saveMenuItemText}>Add to Collections</Text>
              <MaterialIcons
                name={showCollectionPicker ? 'expand-less' : 'expand-more'}
                size={24}
                color={theme.colors.foreground3}
              />
            </TouchableOpacity>

            {/* Collection Picker */}
            {showCollectionPicker && (
              <View>
                {collections.length === 0 ? (
                  <Text
                    style={[
                      styles.collectionName,
                      {paddingHorizontal: 20, paddingVertical: 12},
                    ]}>
                    No collections yet
                  </Text>
                ) : (
                  collections.map(collection => (
                    <TouchableOpacity
                      key={collection.id}
                      style={styles.collectionItem}
                      onPress={() => handleAddToCollection(collection.id)}>
                      <View
                        style={[
                          styles.collectionColor,
                          {backgroundColor: collection.color},
                        ]}>
                        <MaterialIcons name="folder" size={18} color="#fff" />
                      </View>
                      <Text style={styles.collectionName}>
                        {collection.name}
                      </Text>
                      <Text style={styles.collectionCount}>
                        {collection.items.length} items
                      </Text>
                    </TouchableOpacity>
                  ))
                )}
              </View>
            )}

            {/* Share Link */}
            {/* <TouchableOpacity style={styles.saveMenuItem} onPress={handleShare}>
              <View style={styles.saveMenuItemIcon}>
                <MaterialIcons name="share" size={22} color="#3b82f6" />
              </View>
              <Text style={styles.saveMenuItemText}>Share Link</Text>
              <MaterialIcons
                name="ios-share"
                size={20}
                color={theme.colors.foreground3}
              />
            </TouchableOpacity> */}

            {/* View Bookmarks */}
            <TouchableOpacity
              style={styles.saveMenuItem}
              onPress={handleOpenBookmarks}>
              <View style={styles.saveMenuItemIcon}>
                <MaterialIcons
                  name="bookmarks"
                  size={22}
                  color={theme.colors.primary}
                />
              </View>
              <Text style={styles.saveMenuItemText}>Bookmarks</Text>
              <Text style={styles.collectionCount}>{bookmarks.length}</Text>
            </TouchableOpacity>

            {/* Auto-fill Settings */}
            <TouchableOpacity
              style={styles.saveMenuItem}
              onPress={() => {
                setShowSaveMenu(false);
                setShowAutofillSettings(true);
              }}>
              <View style={styles.saveMenuItemIcon}>
                <MaterialIcons name="lock" size={22} color="#10b981" />
              </View>
              <Text style={styles.saveMenuItemText}>Auto-fill Settings</Text>
              <MaterialIcons
                name="chevron-right"
                size={20}
                color={theme.colors.foreground3}
              />
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* DEBUG: Price Extraction Display - hidden from UI but logic preserved */}
      {/* {debugInfo && (
        <View style={styles.debugPanel}>
          <View style={styles.debugHeader}>
            <Text style={styles.debugTitle}>Last Extraction:</Text>
            <TouchableOpacity
              onPress={() => setShowDebugDetail(!showDebugDetail)}>
              <Text style={styles.debugToggle}>
                {showDebugDetail ? '▼' : '▶'}
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.debugText}>
            💰 Price: {debugInfo.price ? `$${debugInfo.price}` : '—'}
          </Text>
          <Text style={styles.debugText}>
            🏷️ Brand: {debugInfo.brand || '—'}
          </Text>
          <Text style={styles.debugText}>
            👕 Category: {debugInfo.category || '—'}
          </Text>
          <Text style={styles.debugText}>
            📏 Sizes:{' '}
            {debugInfo.sizesViewed?.length
              ? debugInfo.sizesViewed.join(', ')
              : '—'}
          </Text>
          <Text style={styles.debugText}>
            🎨 Colors:{' '}
            {debugInfo.colorsViewed?.length
              ? debugInfo.colorsViewed.join(', ')
              : '—'}
          </Text>
          <Text style={styles.debugText}>
            📄 Page text:{' '}
            {debugInfo.pageTextLength
              ? `${debugInfo.pageTextLength} chars`
              : '0 chars'}
          </Text>

          {showDebugDetail && (
            <View style={styles.debugDetail}>
              <Text style={styles.debugDetailTitle}>Input (Title + URL):</Text>
              <Text style={styles.debugDetailText} numberOfLines={3}>
                {debugInfo.inputText?.substring(0, 150) || '(empty)'}
              </Text>

              {debugInfo.pageTextPreview && (
                <>
                  <Text style={styles.debugDetailTitle}>
                    Page Text Preview:
                  </Text>
                  <Text style={styles.debugDetailText} numberOfLines={4}>
                    {debugInfo.pageTextPreview}
                  </Text>
                </>
              )}
            </View>
          )}

          <TouchableOpacity onPress={() => setDebugInfo(null)}>
            <Text style={styles.debugDismiss}>✕ Dismiss</Text>
          </TouchableOpacity>
        </View>
      )} */}

      {/* Bookmarks Modal */}
      <Modal
        visible={showBookmarksModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBookmarksModal(false)}>
        <View style={styles.bookmarksModalContainer}>
          {/* Header */}
          <View style={styles.bookmarksModalHeader}>
            <TouchableOpacity
              onPress={() => setShowBookmarksModal(false)}
              style={styles.bookmarksCloseButton}>
              <MaterialIcons
                name="close"
                size={24}
                color={theme.colors.foreground}
              />
            </TouchableOpacity>
            <TouchableOpacity style={styles.bookmarksMenuButton}>
              <MaterialIcons
                name="more-horiz"
                size={24}
                color={theme.colors.foreground}
              />
            </TouchableOpacity>
          </View>

          {/* Search Bar */}
          <View style={styles.bookmarksSearchContainer}>
            <MaterialIcons
              name="search"
              size={20}
              color={theme.colors.foreground3}
              style={styles.bookmarksSearchIcon}
            />
            <TextInput
              style={styles.bookmarksSearchInput}
              placeholder="Search Bookmarks"
              placeholderTextColor={theme.colors.foreground3}
            />
            {/* 🔥 VOICE ADD – functional mic */}
            <TouchableOpacity
              onPressIn={handleMicPressIn}
              onPressOut={handleMicPressOut}>
              <MaterialIcons
                name={isRecording ? 'mic' : 'mic-none'}
                size={20}
                color={
                  isRecording ? theme.colors.primary : theme.colors.foreground3
                }
                style={styles.bookmarksSearchMic}
              />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.bookmarksModalContent}>
            {activeBookmarksTab === 'bookmarks' ? (
              <>
                {/* Recently Saved */}
                {bookmarks.length > 0 && (
                  <View style={styles.recentlySavedSection}>
                    <Text style={styles.sectionHeaderText}>
                      Recently Saved
                      <MaterialIcons
                        name="chevron-right"
                        size={18}
                        color={theme.colors.foreground3}
                      />
                    </Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.recentlySavedScroll}>
                      {bookmarks.slice(0, 5).map(bookmark => (
                        <TouchableOpacity
                          key={bookmark.id}
                          style={styles.recentlySavedCard}
                          onPress={() =>
                            handleBookmarkNavigation(
                              bookmark.url,
                              bookmark.title,
                            )
                          }>
                          <View style={styles.recentlySavedPreview}>
                            <MaterialIcons
                              name="language"
                              size={32}
                              color={theme.colors.foreground3}
                            />
                          </View>
                          <Text
                            style={styles.recentlySavedTitle}
                            numberOfLines={2}>
                            {bookmark.title}
                          </Text>
                          <Text
                            style={styles.recentlySavedUrl}
                            numberOfLines={1}>
                            {bookmark.source}
                          </Text>
                          <View style={styles.recentlySavedBadge}>
                            <MaterialIcons
                              name="schedule"
                              size={10}
                              color={theme.colors.foreground3}
                            />
                            <Text style={styles.recentlySavedBadgeText}>
                              Bookmarks
                            </Text>
                          </View>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}

                {/* Collections Folders */}
                {collections.length > 0 && (
                  <View style={styles.foldersSection}>
                    <Text style={styles.sectionHeaderText}>Collections</Text>
                    {collections.map(collection => (
                      <TouchableOpacity
                        key={collection.id}
                        style={styles.folderItem}>
                        <View
                          style={[
                            styles.folderIcon,
                            {backgroundColor: collection.color + '33'},
                          ]}>
                          <MaterialIcons
                            name="folder"
                            size={20}
                            color={collection.color}
                          />
                        </View>
                        <Text style={styles.folderName}>{collection.name}</Text>
                        <Text style={styles.folderCount}>
                          {collection.items.length}
                        </Text>
                        <MaterialIcons
                          name="chevron-right"
                          size={20}
                          color={theme.colors.foreground3}
                        />
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* All Bookmarks */}
                {bookmarks.length > 0 && (
                  <View style={styles.bookmarksSection}>
                    <Text style={styles.sectionHeaderText}>Bookmarks</Text>
                    {bookmarks.map(bookmark => (
                      <TouchableOpacity
                        key={bookmark.id}
                        style={styles.bookmarkListItem}
                        onPress={() =>
                          handleBookmarkNavigation(bookmark.url, bookmark.title)
                        }>
                        <View style={styles.bookmarkListIcon}>
                          <MaterialIcons
                            name="language"
                            size={16}
                            color={theme.colors.foreground3}
                          />
                        </View>
                        <Text
                          style={styles.bookmarkListTitle}
                          numberOfLines={1}>
                          {bookmark.title}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Empty State */}
                {bookmarks.length === 0 && collections.length === 0 && (
                  <View style={styles.bookmarksEmptyState}>
                    <MaterialIcons
                      name="bookmark-border"
                      size={48}
                      color={theme.colors.foreground3}
                    />
                    <Text style={styles.bookmarksEmptyText}>
                      No bookmarks yet
                    </Text>
                  </View>
                )}
              </>
            ) : (
              <>
                {/* Browsing History */}
                {history.length > 0 ? (
                  <View style={styles.bookmarksSection}>
                    <Text style={styles.sectionHeaderText}>
                      Browsing History
                    </Text>
                    {history.map((item, index) => (
                      <TouchableOpacity
                        key={`${item.url}-${index}`}
                        style={styles.bookmarkListItem}
                        onPress={() =>
                          handleBookmarkNavigation(item.url, item.title)
                        }>
                        <View style={styles.bookmarkListIcon}>
                          <MaterialIcons
                            name="history"
                            size={16}
                            color={theme.colors.foreground3}
                          />
                        </View>
                        <View style={{flex: 1}}>
                          <Text
                            style={styles.bookmarkListTitle}
                            numberOfLines={1}>
                            {item.title}
                          </Text>
                          <Text
                            style={styles.recentlySavedUrl}
                            numberOfLines={1}>
                            {item.source}
                          </Text>
                        </View>
                        {item.visitCount > 1 && (
                          <Text style={styles.folderCount}>
                            {item.visitCount}x
                          </Text>
                        )}
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : (
                  <View style={styles.bookmarksEmptyState}>
                    <MaterialIcons
                      name="history"
                      size={48}
                      color={theme.colors.foreground3}
                    />
                    <Text style={styles.bookmarksEmptyText}>
                      No browsing history
                    </Text>
                  </View>
                )}
              </>
            )}
          </ScrollView>

          {/* Bottom Tab Bar */}
          <View style={styles.bookmarksTabBar}>
            <TouchableOpacity
              style={styles.bookmarksTab}
              onPress={() => {
                triggerHaptic('impactLight');
                setActiveBookmarksTab('bookmarks');
              }}>
              <MaterialIcons
                name="bookmark"
                size={22}
                color={
                  activeBookmarksTab === 'bookmarks'
                    ? theme.colors.primary
                    : theme.colors.foreground3
                }
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.bookmarksTab}
              onPress={() => {
                triggerHaptic('impactLight');
                setActiveBookmarksTab('history');
              }}>
              <MaterialIcons
                name="history"
                size={22}
                color={
                  activeBookmarksTab === 'history'
                    ? theme.colors.primary
                    : theme.colors.foreground3
                }
              />
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Auto-fill Settings Modal */}
      <AutofillSettings
        visible={showAutofillSettings}
        onClose={() => setShowAutofillSettings(false)}
      />

      {/* Tracking Consent Modal */}
      <TrackingConsentModal
        visible={showConsentModal}
        onAccept={handleConsentAccept}
        onDecline={handleConsentDecline}
      />

      {/* Browser Onboarding Modal - First time only */}
      {!isOnboardingLoading && (
        <BrowserOnboardingModal
          visible={showBrowserOnboarding}
          onDismiss={dismissBrowserOnboarding}
        />
      )}

      {/* Add Quick Shop Site Modal */}
      <Modal
        visible={showAddSiteModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowAddSiteModal(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.addSiteModalOverlay}>
          <TouchableOpacity
            style={styles.addSiteModalOverlay}
            activeOpacity={1}
            onPress={() => setShowAddSiteModal(false)}>
            <TouchableOpacity
              activeOpacity={1}
              onPress={e => e.stopPropagation()}
              style={[
                styles.addSiteModalContent,
                {backgroundColor: theme.colors.cardBackground},
              ]}>
              <View style={styles.saveMenuHandle} />
              <Text
                style={[
                  styles.saveMenuTitle,
                  {color: theme.colors.foreground},
                ]}>
                Add Quick Shop Site
              </Text>

              <View style={styles.addSiteInputContainer}>
                <Text
                  style={[
                    styles.addSiteInputLabel,
                    {color: theme.colors.foreground},
                  ]}>
                  Site Name
                </Text>
                <TextInput
                  style={[
                    styles.addSiteInput,
                    {
                      backgroundColor: theme.colors.surface,
                      color: theme.colors.foreground,
                      borderColor: theme.colors.muted,
                    },
                  ]}
                  placeholder="e.g. Nike"
                  placeholderTextColor={theme.colors.foreground}
                  value={newSiteName}
                  onChangeText={setNewSiteName}
                  autoCapitalize="words"
                />
              </View>

              <View style={styles.addSiteInputContainer}>
                <Text
                  style={[
                    styles.addSiteInputLabel,
                    {color: theme.colors.foreground2},
                  ]}>
                  Website URL
                </Text>
                <TextInput
                  style={[
                    styles.addSiteInput,
                    {
                      backgroundColor: theme.colors.surface,
                      color: theme.colors.foreground,
                      borderColor: theme.colors.muted,
                    },
                  ]}
                  placeholder="e.g. https://nike.com"
                  placeholderTextColor={theme.colors.foreground3}
                  value={newSiteUrl}
                  onChangeText={setNewSiteUrl}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              </View>

              <View style={styles.addSiteButtonRow}>
                <TouchableOpacity
                  style={[
                    styles.addSiteModalButton,
                    {backgroundColor: theme.colors.muted},
                  ]}
                  onPress={() => {
                    setShowAddSiteModal(false);
                    setNewSiteName('');
                    setNewSiteUrl('');
                  }}>
                  <Text
                    style={[
                      styles.addSiteButtonText,
                      {color: theme.colors.foreground},
                    ]}>
                    Cancel
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.addSiteModalButton,
                    {backgroundColor: theme.colors.button1},
                  ]}
                  onPress={() => {
                    if (newSiteName.trim() && newSiteUrl.trim()) {
                      let url = newSiteUrl.trim();
                      if (!url.startsWith('http')) {
                        url = 'https://' + url;
                      }
                      addQuickShopSite(newSiteName.trim(), url);
                      triggerHaptic('notificationSuccess');
                      setShowAddSiteModal(false);
                      setNewSiteName('');
                      setNewSiteUrl('');
                    } else {
                      Alert.alert('Error', 'Please enter both name and URL');
                    }
                  }}>
                  <Text style={[styles.addSiteButtonText, {color: '#fff'}]}>
                    Add Site
                  </Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
