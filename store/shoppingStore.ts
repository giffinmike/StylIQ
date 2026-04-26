import {create} from 'zustand';
import {persist, createJSONStorage} from 'zustand/middleware';
import uuid from 'react-native-uuid';
import {sanitizeUrlForAnalytics} from './utils';
import {createUserScopedZustandStorage} from './userScopedZustandStorage';

export type ShoppingItem = {
  id: string;
  title: string;
  url: string;
  imageUrl?: string;
  screenshot?: string; // Base64 encoded webpage screenshot for preview
  price?: number;
  priceHistory?: {price: number; date: number}[]; // GOLD #4
  brand?: string;
  category?: string; // GOLD #2: shoes, tops, dresses, etc
  source: string; // e.g., 'ASOS', 'Amazon', 'Zara'
  addedAt: number;
  lastViewed?: number;
  viewCount?: number; // GOLD #6: times revisited
  sizesViewed?: string[]; // GOLD #7: what sizes they clicked
  colorsViewed?: string[]; // GOLD #10: actual colors clicked
  emotionAtSave?: string; // GOLD #5: mood when saved (from Mentalist)
};

export type BrowsingHistory = {
  url: string;
  title: string;
  source: string;
  visitedAt: number;
  visitCount: number;
  sessionId?: string; // GOLD #3: group related browsing
  dwellTime?: number; // GOLD #1: seconds on page
  scrollDepth?: number; // GOLD #9: 0-100%
  isCartPage?: boolean; // GOLD #3b: detect /cart URLs
  brand?: string; // Brand extracted from URL/title
};

export type Collection = {
  id: string;
  name: string;
  description?: string;
  items: ShoppingItem[];
  color: string; // Theme color for visual organization
  createdAt: number;
  updatedAt: number;
};

export type BrowserTab = {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  screenshot?: string; // Base64 encoded screenshot for tab preview
  needsScreenshotRefresh?: boolean; // True for tabs restored from server that need screenshots captured
  bodyMeasurementsAtTime?: any; // GOLD #8: their measurements when viewing
  sessionId?: string;
  navHistory?: string[]; // Navigation history for back/forward
  navHistoryIndex?: number; // Current position in navigation history
};

export type CartEvent = {
  type: 'add' | 'remove' | 'checkout_start' | 'checkout_complete' | 'cart_view';
  timestamp: number;
  cartUrl: string;
  itemCount?: number;
  cartValue?: number;
  items?: {title: string; price?: number; quantity?: number}[];
  // ✅ FIX: IDEMPOTENCY - client_event_id for ON CONFLICT dedup (REQUIRED)
  clientEventId: string;
};

export type ProductInteraction = {
  id: string;
  // ✅ FIX #3: IDEMPOTENCY - client_event_id for ON CONFLICT dedup
  clientEventId?: string;
  productUrl: string;
  type: 'view' | 'add_to_cart' | 'bookmark';
  timestamp: number;
  sessionId?: string;
  bodyMeasurementsAtTime?: any; // GOLD #8: their measurements when interacting
  cartTimeline?: CartEvent[]; // GOLD: Cart abandonment tracking
};

// SECURITY: Password storage removed - use iOS Keychain via native module instead
// DO NOT store passwords in AsyncStorage/Zustand - they are not encrypted at rest
// See: ios/StylIQ/KeychainModule.swift for secure credential storage

// Form Auto-fill
export type SavedAddress = {
  id: string;
  name: string; // "Home", "Work"
  fullName: string;
  email: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  savedAt: number;
};

export type SavedCard = {
  id: string;
  name: string; // "Visa", "Amex"
  lastFour: string;
  cardholderName: string;
  expiryMonth: number;
  expiryYear: number;
  savedAt: number;
  // Full card number should NEVER be stored (PCI compliance)
};

export type QuickShopSite = {
  id: string;
  name: string;
  url: string;
};

type ShoppingState = {
  // Bookmarks & Favorites
  bookmarks: ShoppingItem[];
  addBookmark: (item: ShoppingItem) => void;
  removeBookmark: (id: string) => void;
  isBookmarked: (url: string) => boolean;

  // History
  history: BrowsingHistory[];
  addToHistory: (
    url: string,
    title: string,
    source: string,
    brand?: string,
  ) => void;
  clearHistory: () => void;
  getRecentHistory: (limit?: number) => BrowsingHistory[];
  getMostVisitedSites: (limit?: number) => BrowsingHistory[];
  getTopShops: (limit?: number) => {source: string; visits: number}[];
  searchHistory: (query: string) => BrowsingHistory[]; // Full-text search

  // SECURITY: Password Manager removed - use iOS Keychain instead
  // See: ios/StylIQ/KeychainModule.swift for secure credential storage

  // Form Auto-fill - Addresses
  savedAddresses: SavedAddress[];
  addAddress: (address: Omit<SavedAddress, 'id' | 'savedAt'>) => void;
  removeAddress: (id: string) => void;

  // Form Auto-fill - Cards
  savedCards: SavedCard[];
  addCard: (card: Omit<SavedCard, 'id' | 'savedAt'>) => void;
  removeCard: (id: string) => void;

  // Collections/Wishlists
  collections: Collection[];
  createCollection: (
    name: string,
    description?: string,
    color?: string,
  ) => void;
  deleteCollection: (id: string) => void;
  addItemToCollection: (collectionId: string, item: ShoppingItem) => void;
  removeItemFromCollection: (collectionId: string, itemId: string) => void;

  // Browser Tabs
  tabs: BrowserTab[];
  currentTabId: string | null;
  addTab: (url: string, title?: string) => void;
  removeTab: (id: string) => void;
  switchTab: (id: string) => void;
  updateTab: (id: string, url: string, title: string) => void;
  updateTabScreenshot: (id: string, screenshot: string) => void;
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  closeAllTabs: () => void;
  updateTabNavHistory: (id: string, url: string) => void;
  navigateTabBack: (id: string) => string | null;
  navigateTabForward: (id: string) => string | null;
  getTabCanGoBack: (id: string) => boolean;
  getTabCanGoForward: (id: string) => boolean;

  // Insights & Analytics
  favoriteShops: string[]; // Most visited/bookmarked shops
  recentSearches: string[];
  addSearch: (query: string) => void;
  clearSearches: () => void;

  // Preferences
  defaultShoppingSites: string[];
  updateDefaultSites: (sites: string[]) => void;

  // Quick Shop Sites (customizable)
  quickShopSites: QuickShopSite[];
  addQuickShopSite: (name: string, url: string) => void;
  removeQuickShopSite: (id: string) => void;

  // GOLD: Session & Interaction Tracking
  currentSessionId: string | null;
  productInteractions: ProductInteraction[];
  startSession: () => void;
  endSession: () => void;
  recordProductInteraction: (
    productUrl: string,
    type: 'view' | 'add_to_cart' | 'bookmark',
    bodyMeasurements?: any,
  ) => void;

  // GOLD: Cart Abandonment & Purchase Tracking
  cartHistory: {
    cartUrl: string;
    events: CartEvent[];
    abandoned: boolean;
    timeToCheckout?: number;
  }[];
  recordCartEvent: (event: CartEvent) => void;
  getCartAbandonmentStats: () => {
    totalCarts: number;
    abandonedCarts: number;
    avgTimeToCheckout: number;
  };

  // GOLD: Update enriched data
  updateBookmarkMetadata: (
    bookmarkId: string,
    metadata: Partial<ShoppingItem>,
  ) => void;
  updateHistoryMetadata: (
    historyUrl: string,
    metadata: Partial<BrowsingHistory>,
  ) => void;

  // AI Shopping Assistant
  aiShoppingAssistantSuggestions: any[];
  setAiShoppingAssistantSuggestions: (suggestions: any[]) => void;
  clearAiShoppingAssistantSuggestions: () => void;
  hasAiSuggestionsLoaded: boolean;
  setHasAiSuggestionsLoaded: (loaded: boolean) => void;
  aiSuggestionsCachedAt: number | null;
  isAiSuggestionsStale: () => boolean;

  // Hydration
  _hasHydrated: boolean;
  setHasHydrated: (hasHydrated: boolean) => void;

  // History clear tracking (to prevent server from restoring cleared history)
  _historyClearedAt: number | null;

  // Tracking Consent (GDPR/Privacy)
  trackingConsent: 'pending' | 'accepted' | 'declined';
  setTrackingConsent: (consent: 'accepted' | 'declined') => void;
  isTrackingEnabled: () => boolean;

  // Server Sync
  lastSyncTimestamp: number | null;
  isSyncing: boolean;
  syncError: string | null;
  pendingChanges: {
    bookmarks: ShoppingItem[];
    deletedBookmarkUrls: string[];
    history: BrowsingHistory[];
    collections: Collection[];
    deletedCollectionIds: string[];
    cartHistory: {
      cartUrl: string;
      events: CartEvent[];
      abandoned: boolean;
      timeToCheckout?: number;
    }[];
  };
  markBookmarkForSync: (bookmark: ShoppingItem) => void;
  markBookmarkDeleted: (url: string) => void;
  markHistoryForSync: (entry: BrowsingHistory) => void;
  markCollectionForSync: (collection: Collection) => void;
  markCollectionDeleted: (id: string) => void;
  markCartHistoryForSync: (cartUrl: string) => void;
  setSyncState: (syncing: boolean, error?: string | null) => void;
  applyServerSync: (data: {
    bookmarks: ShoppingItem[];
    history: BrowsingHistory[];
    collections: Collection[];
    cartHistory?: {
      cartUrl: string;
      events: CartEvent[];
      abandoned: boolean;
      timeToCheckout?: number;
    }[];
    serverTimestamp: number;
  }) => void;
  clearPendingChanges: () => void;
  getPendingChangesForSync: () => {
    bookmarks: ShoppingItem[];
    deletedBookmarkUrls: string[];
    history: BrowsingHistory[];
    collections: Collection[];
    deletedCollectionIds: string[];
    cartHistory: {
      cartUrl: string;
      events: CartEvent[];
      abandoned: boolean;
      timeToCheckout?: number;
    }[];
  };

  // Reset all user data on logout
  resetForLogout: () => void;

  // Clear just the spending/cart history data
  clearCartHistory: () => void;

  // Clear all shopping data (history, bookmarks, collections, cart history, searches)
  clearAllShoppingData: () => void;

  // ============================================
  // DERIVED ANALYTICS METRICS (no new data collection)
  // ============================================

  // Size-switch frequency: count of distinct sizes clicked per product URL
  getSizeSwitchFrequency: (productUrl: string) => number;

  // Cross-session product views: products viewed in multiple sessions
  getCrossSessionProducts: () => {
    url: string;
    title: string;
    sessionCount: number;
    totalViews: number;
  }[];

  // Brand affinity score: % of views per brand (derived from history)
  getBrandAffinityScores: () => {
    brand: string;
    score: number;
    viewCount: number;
  }[];

  // Time-to-action: record and get avg time from page load to bookmark/cart
  recordTimeToAction: (
    productUrl: string,
    actionType: 'bookmark' | 'cart',
    seconds: number,
  ) => void;
  timeToActionLog: {
    clientEventId: string;
    productUrl: string;
    actionType: string;
    seconds: number;
    timestamp: number;
  }[];
  getAvgTimeToAction: (actionType?: 'bookmark' | 'cart') => number;

  // GDPR: Delete all user analytics data
  deleteAllAnalyticsData: () => void;

  // Clear synced GOLD metrics after successful server sync
  clearSyncedGoldMetrics: () => void;
};

export const useShoppingStore = create<ShoppingState>()(
  persist(
    (set, get) => ({
      // Bookmarks
      bookmarks: [],
      addBookmark: (item: ShoppingItem) => {
        set(state => {
          const exists = state.bookmarks.some(b => b.url === item.url);
          if (exists) return state;
          const newBookmark = {...item, addedAt: Date.now()};
          return {
            bookmarks: [newBookmark, ...state.bookmarks],
            // Mark for sync
            pendingChanges: {
              ...state.pendingChanges,
              bookmarks: [...state.pendingChanges.bookmarks, newBookmark],
            },
          };
        });
      },
      removeBookmark: (id: string) => {
        set(state => {
          const bookmark = state.bookmarks.find(b => b.id === id);
          return {
            bookmarks: state.bookmarks.filter(b => b.id !== id),
            // Mark for sync deletion
            pendingChanges: bookmark
              ? {
                  ...state.pendingChanges,
                  bookmarks: state.pendingChanges.bookmarks.filter(
                    b => b.url !== bookmark.url,
                  ),
                  deletedBookmarkUrls:
                    state.pendingChanges.deletedBookmarkUrls.includes(
                      bookmark.url,
                    )
                      ? state.pendingChanges.deletedBookmarkUrls
                      : [
                          ...state.pendingChanges.deletedBookmarkUrls,
                          bookmark.url,
                        ],
                }
              : state.pendingChanges,
          };
        });
      },
      isBookmarked: (url: string) => {
        return get().bookmarks.some(b => b.url === url);
      },

      // History
      history: [],
      addToHistory: (
        url: string,
        title: string,
        source: string,
        brand?: string,
      ) => {
        if (!get().isTrackingEnabled()) return;
        set(state => {
          const existing = state.history.find(h => h.url === url);
          if (existing) {
            const updatedEntry = {
              ...existing,
              visitedAt: Date.now(),
              visitCount: existing.visitCount + 1,
              // Update brand if provided and not already set
              brand: existing.brand || brand,
            };
            return {
              history: [
                updatedEntry,
                ...state.history.filter(h => h.url !== url),
              ].slice(0, 100), // Keep last 100 visits
              // Mark for sync
              pendingChanges: {
                ...state.pendingChanges,
                history: [
                  ...state.pendingChanges.history.filter(h => h.url !== url),
                  updatedEntry,
                ],
              },
            };
          }
          const newEntry: BrowsingHistory = {
            url,
            title,
            source,
            visitedAt: Date.now(),
            visitCount: 1,
            brand,
          };
          return {
            history: [newEntry, ...state.history].slice(0, 100),
            // Mark for sync
            pendingChanges: {
              ...state.pendingChanges,
              history: [...state.pendingChanges.history, newEntry],
            },
          };
        });
      },
      clearHistory: () => set({history: [], _historyClearedAt: Date.now()}),
      getRecentHistory: (limit = 10) => {
        return get()
          .history.sort((a, b) => b.visitedAt - a.visitedAt)
          .slice(0, limit);
      },
      getMostVisitedSites: (limit = 10) => {
        return get()
          .history.sort((a, b) => b.visitCount - a.visitCount)
          .slice(0, limit);
      },
      getTopShops: (limit = 5) => {
        const shopCounts = new Map<string, number>();
        get().history.forEach(item => {
          const current = shopCounts.get(item.source) || 0;
          shopCounts.set(item.source, current + item.visitCount);
        });
        return Array.from(shopCounts.entries())
          .map(([source, visits]) => ({source, visits}))
          .sort((a, b) => b.visits - a.visits)
          .slice(0, limit);
      },
      searchHistory: (query: string) => {
        const q = query.toLowerCase();
        return get().history.filter(
          h =>
            h.title.toLowerCase().includes(q) ||
            h.url.toLowerCase().includes(q) ||
            h.source.toLowerCase().includes(q),
        );
      },

      // SECURITY: Password Manager implementation removed
      // Passwords must be stored in iOS Keychain, not AsyncStorage
      // Use KeychainModule native module for secure credential storage

      // Form Auto-fill - Addresses
      savedAddresses: [],
      addAddress: (address: Omit<SavedAddress, 'id' | 'savedAt'>) => {
        set(state => ({
          savedAddresses: [
            {
              ...address,
              id: `addr_${Date.now()}`,
              savedAt: Date.now(),
            },
            ...state.savedAddresses,
          ],
        }));
      },
      removeAddress: (id: string) => {
        set(state => ({
          savedAddresses: state.savedAddresses.filter(a => a.id !== id),
        }));
      },

      // Form Auto-fill - Cards
      savedCards: [],
      addCard: (card: Omit<SavedCard, 'id' | 'savedAt'>) => {
        set(state => ({
          savedCards: [
            {
              ...card,
              id: `card_${Date.now()}`,
              savedAt: Date.now(),
            },
            ...state.savedCards,
          ],
        }));
      },
      removeCard: (id: string) => {
        set(state => ({
          savedCards: state.savedCards.filter(c => c.id !== id),
        }));
      },

      // Collections
      collections: [],
      createCollection: (
        name: string,
        description?: string,
        color = '#6366f1',
      ) => {
        const collection: Collection = {
          id: `col_${Date.now()}`,
          name,
          description,
          items: [],
          color,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set(state => ({
          collections: [collection, ...state.collections],
          // Mark for sync
          pendingChanges: {
            ...state.pendingChanges,
            collections: [...state.pendingChanges.collections, collection],
          },
        }));
      },
      deleteCollection: (id: string) => {
        set(state => ({
          collections: state.collections.filter(c => c.id !== id),
          // Mark for sync deletion
          pendingChanges: {
            ...state.pendingChanges,
            collections: state.pendingChanges.collections.filter(
              c => c.id !== id,
            ),
            deletedCollectionIds:
              state.pendingChanges.deletedCollectionIds.includes(id)
                ? state.pendingChanges.deletedCollectionIds
                : [...state.pendingChanges.deletedCollectionIds, id],
          },
        }));
      },
      addItemToCollection: (collectionId: string, item: ShoppingItem) => {
        set(state => {
          const updatedCollections = state.collections.map(c => {
            if (c.id === collectionId) {
              const exists = c.items.some(i => i.id === item.id);
              return {
                ...c,
                items: exists
                  ? c.items
                  : [{...item, addedAt: Date.now()}, ...c.items],
                updatedAt: Date.now(),
              };
            }
            return c;
          });
          const updatedCollection = updatedCollections.find(
            c => c.id === collectionId,
          );
          return {
            collections: updatedCollections,
            // Mark collection for sync
            pendingChanges: updatedCollection
              ? {
                  ...state.pendingChanges,
                  collections: [
                    ...state.pendingChanges.collections.filter(
                      c => c.id !== collectionId,
                    ),
                    updatedCollection,
                  ],
                }
              : state.pendingChanges,
          };
        });
      },
      removeItemFromCollection: (collectionId: string, itemId: string) => {
        set(state => {
          const updatedCollections = state.collections.map(c => {
            if (c.id === collectionId) {
              return {
                ...c,
                items: c.items.filter(i => i.id !== itemId),
                updatedAt: Date.now(),
              };
            }
            return c;
          });
          const updatedCollection = updatedCollections.find(
            c => c.id === collectionId,
          );
          return {
            collections: updatedCollections,
            // Mark collection for sync
            pendingChanges: updatedCollection
              ? {
                  ...state.pendingChanges,
                  collections: [
                    ...state.pendingChanges.collections.filter(
                      c => c.id !== collectionId,
                    ),
                    updatedCollection,
                  ],
                }
              : state.pendingChanges,
          };
        });
      },

      // Browser Tabs
      tabs: [],
      currentTabId: null,
      addTab: (url: string, title = 'New Tab') => {
        const tabId = `tab_${Date.now()}`;
        set(state => ({
          tabs: [
            ...state.tabs,
            {
              id: tabId,
              url,
              title,
              navHistory: url ? [url] : [],
              navHistoryIndex: url ? 0 : -1,
            },
          ],
          currentTabId: tabId,
        }));
      },
      removeTab: (id: string) => {
        set(state => {
          const remaining = state.tabs.filter(t => t.id !== id);
          let newCurrentTabId = state.currentTabId;
          if (newCurrentTabId === id && remaining.length > 0) {
            newCurrentTabId = remaining[0].id;
          } else if (remaining.length === 0) {
            newCurrentTabId = null;
          }
          return {
            tabs: remaining,
            currentTabId: newCurrentTabId,
          };
        });
      },
      switchTab: (id: string) => {
        set({currentTabId: id});
      },
      updateTab: (id: string, url: string, title: string) => {
        set(state => ({
          tabs: state.tabs.map(t => (t.id === id ? {...t, id, url, title} : t)),
        }));
      },
      updateTabScreenshot: (id: string, screenshot: string) => {
        set(state => ({
          tabs: state.tabs.map(t => (t.id === id ? {...t, screenshot} : t)),
        }));
      },
      reorderTabs: (fromIndex: number, toIndex: number) => {
        set(state => {
          const newTabs = [...state.tabs];
          const [movedTab] = newTabs.splice(fromIndex, 1);
          newTabs.splice(toIndex, 0, movedTab);
          return {tabs: newTabs};
        });
      },
      closeAllTabs: () => {
        set({tabs: [], currentTabId: null});
      },
      updateTabNavHistory: (id: string, url: string) => {
        set(state => ({
          tabs: state.tabs.map(t => {
            if (t.id !== id) return t;
            const history = t.navHistory || [];
            const index = t.navHistoryIndex ?? -1;
            // If we're not at the end, truncate forward history
            const newHistory = [...history.slice(0, index + 1), url];
            return {
              ...t,
              navHistory: newHistory,
              navHistoryIndex: newHistory.length - 1,
            };
          }),
        }));
      },
      navigateTabBack: (id: string) => {
        const state = get();
        const tab = state.tabs.find(t => t.id === id);
        if (!tab || !tab.navHistory || (tab.navHistoryIndex ?? 0) <= 0)
          return null;
        const newIndex = (tab.navHistoryIndex ?? 0) - 1;
        set({
          tabs: state.tabs.map(t =>
            t.id === id ? {...t, navHistoryIndex: newIndex} : t,
          ),
        });
        return tab.navHistory[newIndex];
      },
      navigateTabForward: (id: string) => {
        const state = get();
        const tab = state.tabs.find(t => t.id === id);
        if (
          !tab ||
          !tab.navHistory ||
          (tab.navHistoryIndex ?? 0) >= tab.navHistory.length - 1
        )
          return null;
        const newIndex = (tab.navHistoryIndex ?? 0) + 1;
        set({
          tabs: state.tabs.map(t =>
            t.id === id ? {...t, navHistoryIndex: newIndex} : t,
          ),
        });
        return tab.navHistory[newIndex];
      },
      getTabCanGoBack: (id: string) => {
        const tab = get().tabs.find(t => t.id === id);
        return !!tab?.navHistory && (tab.navHistoryIndex ?? 0) > 0;
      },
      getTabCanGoForward: (id: string) => {
        const tab = get().tabs.find(t => t.id === id);
        return (
          !!tab?.navHistory &&
          (tab.navHistoryIndex ?? 0) < tab.navHistory.length - 1
        );
      },

      // Insights
      favoriteShops: [],
      recentSearches: [],
      addSearch: (query: string) => {
        set(state => ({
          recentSearches: [
            query,
            ...state.recentSearches.filter(s => s !== query),
          ].slice(0, 20),
        }));
      },
      clearSearches: () => set({recentSearches: []}),

      // Preferences
      defaultShoppingSites: [
        'ASOS',
        'Amazon',
        'H&M',
        'Zara',
        'Shein',
        'SSENSE',
        'Farfetch',
      ],
      updateDefaultSites: (sites: string[]) => {
        set({defaultShoppingSites: sites});
      },

      // Quick Shop Sites (customizable)
      quickShopSites: [
        {id: '1', name: 'Google', url: 'https://www.google.com'},
        {id: '2', name: 'Louis Vuitton', url: 'https://us.louisvuitton.com'},
        {id: '3', name: 'Versace', url: 'https://www.versace.com'},
        {id: '4', name: 'Gucci', url: 'https://www.gucci.com'},
        {id: '5', name: 'Chanel', url: 'https://www.chanel.com'},
        {id: '6', name: 'Amazon', url: 'https://www.amazon.com'},
        {id: '7', name: 'ASOS', url: 'https://www.asos.com'},
        {id: '8', name: 'Zara', url: 'https://www.zara.com'},
        {id: '9', name: 'H&M', url: 'https://www.hm.com'},  
        {id: '10', name: 'Farfetch', url: 'https://www.farfetch.com'},
        {id: '11', name: 'Nordstrom', url: 'https://www.nordstrom.com'},
        {id: '12', name: 'Prada', url: 'https://www.prada.com'},
        {id: '13', name: 'Neiman Marcus', url: 'https://www.neimanmarcus.com'},
        {id: '14', name: 'Saks Fifth Avenue', url: 'https://www.saksfifthavenue.com'},
        {id: '15', name: 'The Real Real', url: 'https://www.therealreal.com'},
        {id: '16', name: 'Hermès', url: 'https://www.hermes.com'},
        {id: '17', name: 'Bloomingdale’s', url: 'https://www.bloomingdales.com'},
        {id: '18', name: 'Burberry', url: 'https://us.burberry.com'},
        {id: '19', name: 'SSENSE', url: 'https://www.ssense.com'},
        {id: '20', name: 'Bergdorf Goodman', url: 'https://www.bergdorfgoodman.com'},
        {id: '21', name: 'Gilt', url: 'https://www.gilt.com'},
        {id: '22', name: 'Rue La La', url: 'https://www.ruelala.com'},
      ],
      addQuickShopSite: (name: string, url: string) => {
        const id = `qs_${Date.now()}`;
        set(state => ({
          quickShopSites: [...state.quickShopSites, {id, name, url}],
        }));
      },
      removeQuickShopSite: (id: string) => {
        set(state => ({
          quickShopSites: state.quickShopSites.filter(site => site.id !== id),
        }));
      },

      // GOLD: Session & Interaction Tracking
      currentSessionId: null,
      productInteractions: [],
      startSession: () => {
        const sessionId = `session_${Date.now()}`;
        set({currentSessionId: sessionId});
      },
      endSession: () => {
        set({currentSessionId: null});
      },
      recordProductInteraction: (
        productUrl: string,
        type: 'view' | 'add_to_cart' | 'bookmark',
        bodyMeasurements?: any,
      ) => {
        // ✅ FIX #1: CONSENT GATING - Do not capture without explicit opt-in
        if (!get().isTrackingEnabled()) {
          // console.log(
          //   '[Store] Product interaction blocked: tracking consent not accepted',
          // );
          return;
        }

        // ✅ FIX #2: URL SANITIZATION - Strip query params and hash before storage
        const sanitizedUrl = sanitizeUrlForAnalytics(productUrl);

        // ✅ FIX #4: EMPTY URL GUARD - Do not store events with empty/invalid URLs
        if (!sanitizedUrl) {
          // console.log(
          //   '[Store] Product interaction blocked: invalid URL after sanitization',
          // );
          return;
        }

        set(state => ({
          productInteractions: [
            {
              id: `interaction_${Date.now()}`,
              // ✅ FIX #3: IDEMPOTENCY - Generate client_event_id (UUID) for deduplication
              clientEventId: uuid.v4() as string,
              productUrl: sanitizedUrl,
              type,
              timestamp: Date.now(),
              sessionId: state.currentSessionId || undefined,
              bodyMeasurementsAtTime: bodyMeasurements,
            },
            ...state.productInteractions,
          ].slice(0, 500), // Keep last 500 interactions
        }));
      },

      // GOLD: Cart Abandonment Tracking
      cartHistory: [],
      recordCartEvent: (event: CartEvent) => {
        // ✅ FIX #1: CONSENT GATING - Do not capture without explicit opt-in
        if (!get().isTrackingEnabled()) {
          // console.log(
          //   '[Store] Cart event blocked: tracking consent not accepted',
          // );
          return;
        }

        // ✅ FIX #2: URL SANITIZATION - Strip query params and hash before storage
        const sanitizedCartUrl = sanitizeUrlForAnalytics(event.cartUrl);

        // ✅ FIX #4: EMPTY URL GUARD - Do not store events with empty/invalid URLs
        if (!sanitizedCartUrl) {
          // console.log(
          //   '[Store] Cart event blocked: invalid URL after sanitization',
          // );
          return;
        }

        // ✅ FIX #3: IDEMPOTENCY - Generate client_event_id (UUID) for deduplication
        const sanitizedEvent: CartEvent = {
          ...event,
          cartUrl: sanitizedCartUrl,
          clientEventId: uuid.v4() as string,
        };

        set(state => {
          const cartUrl = sanitizedCartUrl;
          let updatedHistory = [...state.cartHistory];

          // Find existing cart session or create new one
          let cartSession = updatedHistory.find(
            c => c.cartUrl === cartUrl && !c.abandoned,
          );

          if (!cartSession) {
            cartSession = {
              cartUrl,
              events: [],
              abandoned: false,
              timeToCheckout: undefined,
            };
            updatedHistory.push(cartSession);
          }

          // Deduplicate: check if a similar event was already recorded recently
          // Skip if same event type with same cartValue within 30 seconds
          const isDuplicate = cartSession.events.some(
            e =>
              e.type === sanitizedEvent.type &&
              e.cartValue === sanitizedEvent.cartValue &&
              Math.abs(e.timestamp - sanitizedEvent.timestamp) < 30000,
          );

          if (isDuplicate) {
            // console.log(
            //   '[Store] Skipping duplicate cart event:',
            //   sanitizedEvent.type,
            // );
            return state; // Return unchanged state
          }

          // Add event to timeline
          cartSession.events.push(sanitizedEvent);

          // Update cart status based on event type
          if (sanitizedEvent.type === 'checkout_complete') {
            const firstAdd = cartSession.events.find(e => e.type === 'add');
            if (firstAdd) {
              cartSession.timeToCheckout =
                sanitizedEvent.timestamp - firstAdd.timestamp;
            }
          } else if (sanitizedEvent.type === 'checkout_start') {
            const firstAdd = cartSession.events.find(e => e.type === 'add');
            if (firstAdd) {
              cartSession.timeToCheckout =
                sanitizedEvent.timestamp - firstAdd.timestamp;
            }
          }

          return {
            cartHistory: updatedHistory.slice(0, 100), // Keep last 100 carts
          };
        });

        // Mark cart session for sync
        get().markCartHistoryForSync(sanitizedCartUrl);
      },

      getCartAbandonmentStats: () => {
        const state = get();
        const totalCarts = state.cartHistory.length;
        const abandonedCarts = state.cartHistory.filter(
          c => !c.events.some(e => e.type === 'checkout_complete'),
        ).length;
        const checkoutTimes = state.cartHistory
          .filter(c => c.timeToCheckout !== undefined)
          .map(c => c.timeToCheckout || 0);
        const avgTimeToCheckout =
          checkoutTimes.length > 0
            ? Math.round(
                checkoutTimes.reduce((a, b) => a + b, 0) / checkoutTimes.length,
              )
            : 0;

        return {
          totalCarts,
          abandonedCarts,
          avgTimeToCheckout,
        };
      },

      updateBookmarkMetadata: (
        bookmarkId: string,
        metadata: Partial<ShoppingItem>,
      ) => {
        set(state => ({
          bookmarks: state.bookmarks.map(b =>
            b.id === bookmarkId ? {...b, ...metadata} : b,
          ),
        }));
      },
      updateHistoryMetadata: (
        historyUrl: string,
        metadata: Partial<BrowsingHistory>,
      ) => {
        if (!get().isTrackingEnabled()) return;
        set(state => ({
          history: state.history.map(h =>
            h.url === historyUrl ? {...h, ...metadata} : h,
          ),
        }));
      },

      // AI Shopping Assistant
      aiShoppingAssistantSuggestions: [],
      setAiShoppingAssistantSuggestions: (suggestions: any[]) => {
        set({
          aiShoppingAssistantSuggestions: suggestions,
          aiSuggestionsCachedAt: Date.now(),
        });
      },
      clearAiShoppingAssistantSuggestions: () => {
        set({
          aiShoppingAssistantSuggestions: [],
          aiSuggestionsCachedAt: null,
        });
      },
      hasAiSuggestionsLoaded: false,
      setHasAiSuggestionsLoaded: (loaded: boolean) => {
        set({hasAiSuggestionsLoaded: loaded});
      },
      aiSuggestionsCachedAt: null,
      isAiSuggestionsStale: () => {
        const state = get();
        if (!state.aiSuggestionsCachedAt) return true;
        const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24-hour cache for production efficiency
        return Date.now() - state.aiSuggestionsCachedAt > CACHE_DURATION_MS;
      },

      // Hydration
      _hasHydrated: false,
      setHasHydrated: (hasHydrated: boolean) => {
        set({_hasHydrated: hasHydrated});
      },

      // History clear tracking
      _historyClearedAt: null,

      // Tracking Consent (GDPR/Privacy)
      trackingConsent: 'pending' as 'pending' | 'accepted' | 'declined',
      setTrackingConsent: (consent: 'accepted' | 'declined') => {
        set({trackingConsent: consent});
      },
      isTrackingEnabled: () => {
        return get().trackingConsent === 'accepted';
      },

      // Server Sync State & Methods
      lastSyncTimestamp: null,
      isSyncing: false,
      syncError: null,
      pendingChanges: {
        bookmarks: [],
        deletedBookmarkUrls: [],
        history: [],
        collections: [],
        deletedCollectionIds: [],
        cartHistory: [],
      },

      markBookmarkForSync: (bookmark: ShoppingItem) => {
        set(state => {
          const existing = state.pendingChanges.bookmarks.find(
            b => b.url === bookmark.url,
          );
          if (existing) {
            return {
              pendingChanges: {
                ...state.pendingChanges,
                bookmarks: state.pendingChanges.bookmarks.map(b =>
                  b.url === bookmark.url ? bookmark : b,
                ),
              },
            };
          }
          return {
            pendingChanges: {
              ...state.pendingChanges,
              bookmarks: [...state.pendingChanges.bookmarks, bookmark],
            },
          };
        });
      },

      markBookmarkDeleted: (url: string) => {
        set(state => ({
          pendingChanges: {
            ...state.pendingChanges,
            // Remove from pending bookmarks if it was there
            bookmarks: state.pendingChanges.bookmarks.filter(
              b => b.url !== url,
            ),
            // Add to deleted list if not already there
            deletedBookmarkUrls:
              state.pendingChanges.deletedBookmarkUrls.includes(url)
                ? state.pendingChanges.deletedBookmarkUrls
                : [...state.pendingChanges.deletedBookmarkUrls, url],
          },
        }));
      },

      markHistoryForSync: (entry: BrowsingHistory) => {
        set(state => {
          const existing = state.pendingChanges.history.find(
            h => h.url === entry.url,
          );
          if (existing) {
            return {
              pendingChanges: {
                ...state.pendingChanges,
                history: state.pendingChanges.history.map(h =>
                  h.url === entry.url ? entry : h,
                ),
              },
            };
          }
          return {
            pendingChanges: {
              ...state.pendingChanges,
              history: [...state.pendingChanges.history, entry],
            },
          };
        });
      },

      markCollectionForSync: (collection: Collection) => {
        set(state => {
          const existing = state.pendingChanges.collections.find(
            c => c.id === collection.id,
          );
          if (existing) {
            return {
              pendingChanges: {
                ...state.pendingChanges,
                collections: state.pendingChanges.collections.map(c =>
                  c.id === collection.id ? collection : c,
                ),
              },
            };
          }
          return {
            pendingChanges: {
              ...state.pendingChanges,
              collections: [...state.pendingChanges.collections, collection],
            },
          };
        });
      },

      markCollectionDeleted: (id: string) => {
        set(state => ({
          pendingChanges: {
            ...state.pendingChanges,
            // Remove from pending collections if it was there
            collections: state.pendingChanges.collections.filter(
              c => c.id !== id,
            ),
            // Add to deleted list if not already there
            deletedCollectionIds:
              state.pendingChanges.deletedCollectionIds.includes(id)
                ? state.pendingChanges.deletedCollectionIds
                : [...state.pendingChanges.deletedCollectionIds, id],
          },
        }));
      },

      markCartHistoryForSync: (cartUrl: string) => {
        const cart = get().cartHistory.find(c => c.cartUrl === cartUrl);
        if (!cart) return;

        set(state => {
          // Ensure cartHistory exists (migration from older store versions)
          const pendingCartHistory = state.pendingChanges.cartHistory || [];
          const existing = pendingCartHistory.find(c => c.cartUrl === cartUrl);
          if (existing) {
            return {
              pendingChanges: {
                ...state.pendingChanges,
                cartHistory: pendingCartHistory.map(c =>
                  c.cartUrl === cartUrl ? cart : c,
                ),
              },
            };
          }
          return {
            pendingChanges: {
              ...state.pendingChanges,
              cartHistory: [...pendingCartHistory, cart],
            },
          };
        });
      },

      setSyncState: (syncing: boolean, error?: string | null) => {
        set({
          isSyncing: syncing,
          syncError: error ?? null,
        });
      },

      applyServerSync: (data: {
        bookmarks: ShoppingItem[];
        history: BrowsingHistory[];
        collections: Collection[];
        cartHistory?: {
          cartUrl: string;
          events: CartEvent[];
          abandoned: boolean;
          timeToCheckout?: number;
        }[];
        tabs?: {
          id: string;
          url: string;
          title: string;
          screenshot?: string;
        }[];
        currentTabId?: string | null;
        serverTimestamp: number;
      }) => {
        // console.log('[ShoppingStore] applyServerSync called with:', {
        //   bookmarks: data.bookmarks?.length || 0,
        //   history: data.history?.length || 0,
        //   collections: data.collections?.length || 0,
        //   cartHistory: data.cartHistory?.length || 0,
        //   tabs: data.tabs?.length || 0,
        //   historyUrls: data.history?.map(h => h.url),
        // });

        set(state => {
          // console.log('[ShoppingStore] Current local state:', {
          //   bookmarks: state.bookmarks?.length || 0,
          //   history: state.history?.length || 0,
          //   collections: state.collections?.length || 0,
          //   cartHistory: state.cartHistory?.length || 0,
          //   _historyClearedAt: state._historyClearedAt,
          //   localHistoryUrls: state.history?.map(h => h.url),
          // });

          // Merge server data with local data, preferring local for conflicts
          // This prevents wiping local data when server is empty

          // Merge bookmarks - use URL as key, prefer server version if exists
          const serverBookmarkUrls = new Set(data.bookmarks.map(b => b.url));
          const mergedBookmarks = [
            ...data.bookmarks,
            ...state.bookmarks.filter(b => !serverBookmarkUrls.has(b.url)),
          ];

          // Merge history - use URL as key, prefer local visitCount (it's more up-to-date)
          // If history was recently cleared, don't restore from server
          const historyClearedRecently =
            state._historyClearedAt &&
            state._historyClearedAt > (data.serverTimestamp || 0);

          const mergedHistory = historyClearedRecently
            ? state.history // Keep empty if cleared
            : [
                ...state.history.map(localH => {
                  const serverH = data.history.find(h => h.url === localH.url);
                  if (serverH) {
                    // Merge: keep higher visitCount, more recent visitedAt
                    return {
                      ...serverH,
                      ...localH,
                      visitCount: Math.max(
                        localH.visitCount,
                        serverH.visitCount || 0,
                      ),
                      visitedAt: Math.max(
                        localH.visitedAt,
                        serverH.visitedAt || 0,
                      ),
                    };
                  }
                  return localH;
                }),
                ...data.history.filter(
                  h => !state.history.some(lh => lh.url === h.url),
                ),
              ].slice(0, 100);

          // Merge collections - use ID as key, prefer server version if exists
          const serverCollectionIds = new Set(data.collections.map(c => c.id));
          const mergedCollections = [
            ...data.collections,
            ...state.collections.filter(c => !serverCollectionIds.has(c.id)),
          ];

          // Merge cart history - use cartUrl as key, prefer server version if exists
          const serverCartUrls = new Set(
            (data.cartHistory || []).map(c => c.cartUrl),
          );
          const mergedCartHistory = [
            ...(data.cartHistory || []),
            ...state.cartHistory.filter(c => !serverCartUrls.has(c.cartUrl)),
          ].slice(0, 100);

          // For tabs, merge local and server tabs
          // Preserve local screenshots since they're not stored in the database
          // Also preserve local-only tabs that haven't been synced to server yet
          const localTabsById = new Map(state.tabs.map(t => [t.id, t]));
          const serverTabIds = new Set((data.tabs || []).map(t => t.id));

          // Merge server tabs with local screenshots
          const serverTabsWithScreenshots = (data.tabs || []).map(serverTab => {
            const localTab = localTabsById.get(serverTab.id);
            return {
              ...serverTab,
              screenshot: localTab?.screenshot || serverTab.screenshot,
            };
          });

          // Keep local-only tabs (not on server) - these haven't been synced yet
          const localOnlyTabs = state.tabs.filter(t => !serverTabIds.has(t.id));

          // Final merged tabs: server tabs (with preserved screenshots) + local-only tabs
          const mergedTabs = [...serverTabsWithScreenshots, ...localOnlyTabs];

          // IMPORTANT: Always preserve local currentTabId if it exists and is valid
          // This prevents sync from switching the user's active tab while browsing
          // (e.g., when iOS password autofill triggers an app state change)
          const localTabStillExists =
            state.currentTabId &&
            mergedTabs.some(t => t.id === state.currentTabId);

          const mergedCurrentTabId = localTabStillExists
            ? state.currentTabId // Keep user's current tab
            : state.currentTabId ||
              data.currentTabId ||
              (mergedTabs.length > 0 ? mergedTabs[0].id : null);

          // console.log('[ShoppingStore] Merged result:', {
          //   bookmarks: mergedBookmarks.length,
          //   history: mergedHistory.length,
          //   collections: mergedCollections.length,
          //   cartHistory: mergedCartHistory.length,
          //   tabs: mergedTabs.length,
          //   mergedHistoryUrls: mergedHistory.map(h => h.url),
          //   mergedHistoryVisitCounts: mergedHistory.map(h => ({url: h.url, visitCount: h.visitCount})),
          // });

          return {
            bookmarks: mergedBookmarks,
            history: mergedHistory,
            collections: mergedCollections,
            cartHistory: mergedCartHistory,
            tabs: mergedTabs,
            currentTabId: mergedCurrentTabId,
            lastSyncTimestamp: data.serverTimestamp,
            syncError: null,
          };
        });
      },

      clearPendingChanges: () => {
        set({
          pendingChanges: {
            bookmarks: [],
            deletedBookmarkUrls: [],
            history: [],
            collections: [],
            deletedCollectionIds: [],
            cartHistory: [],
          },
        });
      },

      getPendingChangesForSync: () => {
        return get().pendingChanges;
      },

      // Reset all user data on logout (analytics are user-specific and stored in DB)
      // MULTI-ACCOUNT: Clears in-memory state only. Persisted data is user-scoped.
      resetForLogout: () => {
        // console.log(
        //   '[ShoppingStore] resetForLogout called - clearing all data',
        // );
        // MULTI-ACCOUNT FIX: Clear tabs to prevent data leakage between accounts
        // Tabs contain URLs, screenshots, and browsing history that are user-specific
        set({
          bookmarks: [],
          history: [],
          collections: [],
          favoriteShops: [],
          productInteractions: [],
          cartHistory: [],
          currentSessionId: null,
          aiShoppingAssistantSuggestions: [],
          hasAiSuggestionsLoaded: false,
          aiSuggestionsCachedAt: null,
          // CRITICAL: Clear sensitive data (passwords now in iOS Keychain)
          savedAddresses: [],
          savedCards: [],
          // MULTI-ACCOUNT FIX: Clear tabs to prevent cross-account data leakage
          tabs: [],
          currentTabId: null,
          // Clear sync state so next login triggers full sync
          lastSyncTimestamp: null,
          isSyncing: false,
          syncError: null,
          pendingChanges: {
            bookmarks: [],
            deletedBookmarkUrls: [],
            history: [],
            collections: [],
            deletedCollectionIds: [],
            cartHistory: [],
          },
          // Clear time-to-action log
          timeToActionLog: [],
          // IMPORTANT: Clear _historyClearedAt so history can be restored from server on next login
          _historyClearedAt: null,
          // Reset hydration state so store rehydrates on next login
          _hasHydrated: false,
        });
        // console.log('[ShoppingStore] resetForLogout complete');
      },

      clearCartHistory: () => {
        set(state => ({
          cartHistory: [],
          pendingChanges: {
            ...state.pendingChanges,
            cartHistory: [],
          },
        }));
      },

      clearAllShoppingData: () => {
        set({
          bookmarks: [],
          history: [],
          collections: [],
          cartHistory: [],
          recentSearches: [],
          productInteractions: [],
          tabs: [],
          currentTabId: null,
          _historyClearedAt: Date.now(),
          pendingChanges: {
            bookmarks: [],
            deletedBookmarkUrls: [],
            history: [],
            collections: [],
            deletedCollectionIds: [],
            cartHistory: [],
          },
        });
      },

      // ============================================
      // DERIVED ANALYTICS METRICS (no new data collection)
      // All derived from existing signals - respects opt-in
      // ============================================

      // Size-switch frequency: count of distinct sizes from bookmarks
      getSizeSwitchFrequency: (productUrl: string) => {
        if (!get().isTrackingEnabled()) return 0;
        const bookmark = get().bookmarks.find(b => b.url === productUrl);
        return bookmark?.sizesViewed?.length || 0;
      },

      // Cross-session product views: products viewed in multiple sessions
      getCrossSessionProducts: () => {
        if (!get().isTrackingEnabled()) return [];
        const history = get().history;
        const sessionMap = new Map<string, Set<string>>();

        // Group by URL and collect unique session IDs
        history.forEach(entry => {
          if (entry.sessionId) {
            if (!sessionMap.has(entry.url)) {
              sessionMap.set(entry.url, new Set());
            }
            sessionMap.get(entry.url)!.add(entry.sessionId);
          }
        });

        // Filter to products with 2+ sessions and sort by session count
        const results: {
          url: string;
          title: string;
          sessionCount: number;
          totalViews: number;
        }[] = [];
        sessionMap.forEach((sessions, url) => {
          if (sessions.size >= 2) {
            const entry = history.find(h => h.url === url);
            results.push({
              url,
              title: entry?.title || '',
              sessionCount: sessions.size,
              totalViews: entry?.visitCount || 1,
            });
          }
        });

        return results.sort((a, b) => b.sessionCount - a.sessionCount);
      },

      // Brand affinity score: % of views per brand
      getBrandAffinityScores: () => {
        if (!get().isTrackingEnabled()) return [];
        const history = get().history;
        const brandCounts = new Map<string, number>();
        let totalViews = 0;

        history.forEach(entry => {
          if (entry.brand) {
            brandCounts.set(
              entry.brand,
              (brandCounts.get(entry.brand) || 0) + entry.visitCount,
            );
            totalViews += entry.visitCount;
          }
        });

        if (totalViews === 0) return [];

        const results: {brand: string; score: number; viewCount: number}[] = [];
        brandCounts.forEach((count, brand) => {
          results.push({
            brand,
            score: Math.round((count / totalViews) * 100),
            viewCount: count,
          });
        });

        return results.sort((a, b) => b.score - a.score);
      },

      // Time-to-action tracking
      timeToActionLog: [],

      recordTimeToAction: (
        productUrl: string,
        actionType: 'bookmark' | 'cart',
        seconds: number,
      ) => {
        if (!get().isTrackingEnabled()) return;

        // ✅ FIX: URL SANITIZATION - Strip query params and hash before storage
        const sanitizedUrl = sanitizeUrlForAnalytics(productUrl);

        // ✅ FIX: EMPTY URL GUARD - Do not store events with empty/invalid URLs
        if (!sanitizedUrl) {
          // console.log(
          //   '[Store] Time-to-action blocked: invalid URL after sanitization',
          // );
          return;
        }

        const timestamp = Date.now();
        // Generate unique client event ID (UUID) for deduplication
        const clientEventId = uuid.v4() as string;
        set(state => ({
          timeToActionLog: [
            ...state.timeToActionLog,
            {
              clientEventId,
              productUrl: sanitizedUrl,
              actionType,
              seconds,
              timestamp,
            },
          ].slice(-100), // Keep last 100 entries
        }));
      },

      getAvgTimeToAction: (actionType?: 'bookmark' | 'cart') => {
        if (!get().isTrackingEnabled()) return 0;
        const log = get().timeToActionLog;
        const filtered = actionType
          ? log.filter(e => e.actionType === actionType)
          : log;

        if (filtered.length === 0) return 0;
        const sum = filtered.reduce((acc, e) => acc + e.seconds, 0);
        return Math.round(sum / filtered.length);
      },

      // Clear Shopping Analytics: Delete all local shopping behavior analytics
      // Does NOT affect: auth, payments, wardrobe, community, bookmarks, collections
      deleteAllAnalyticsData: () => {
        set({
          // Clear all analytics-related data
          history: [],
          productInteractions: [],
          cartHistory: [],
          recentSearches: [],
          timeToActionLog: [],
          // Clear open tabs
          tabs: [],
          currentTabId: null,
          // Reset analytics session (generate fresh ID on next interaction)
          currentSessionId: null,
          // Clear AI personalization derived from analytics
          aiShoppingAssistantSuggestions: [],
          hasAiSuggestionsLoaded: false,
          aiSuggestionsCachedAt: null,
          // Keep bookmarks/collections as they're user-created content
          // Clear pending analytics sync queue (do NOT flush first)
          pendingChanges: {
            bookmarks: [],
            deletedBookmarkUrls: [],
            history: [],
            collections: [],
            deletedCollectionIds: [],
            cartHistory: [],
          },
          // Mark history cleared to prevent server from restoring
          _historyClearedAt: Date.now(),
        });
        // console.log('[Analytics] Shopping analytics cleared');
      },

      // Clear synced GOLD metrics after successful server sync
      clearSyncedGoldMetrics: () => {
        set({
          // Clear time-to-action log (now persisted to Postgres)
          timeToActionLog: [],
          // Clear product interactions (now persisted to Postgres)
          productInteractions: [],
        });
        // console.log('[Sync] GOLD metrics cleared after successful sync');
      },
    }),
    {
      name: 'shopping-store',
      // Use user-scoped storage adapter for multi-account support
      storage: createJSONStorage(() => createUserScopedZustandStorage('shopping-store')),
      // MULTI-ACCOUNT: Skip auto-hydration on store creation
      // We manually trigger rehydration after active user is set in UUIDContext
      skipHydration: true,
      version: 2,
      migrate: (persistedState: any, version: number) => {
        if (version < 2) {
          // Reset quickShopSites to new defaults
          return {
            ...persistedState,
            quickShopSites: [
              {id: '1', name: 'Google', url: 'https://www.google.com'},
              {id: '2', name: 'Louis Vuitton', url: 'https://us.louisvuitton.com'},
              {id: '3', name: 'Versace', url: 'https://www.versace.com'},
              {id: '4', name: 'Gucci', url: 'https://www.gucci.com'},
              {id: '5', name: 'Chanel', url: 'https://www.chanel.com'},
              {id: '6', name: 'Amazon', url: 'https://www.amazon.com'},
              {id: '7', name: 'ASOS', url: 'https://www.asos.com'},
              {id: '8', name: 'Zara', url: 'https://www.zara.com'},
              {id: '9', name: 'H&M', url: 'https://www.hm.com'},
              {id: '10', name: 'Farfetch', url: 'https://www.farfetch.com'},
              {id: '11', name: 'Nordstrom', url: 'https://www.nordstrom.com'},
              {id: '12', name: 'Prada', url: 'https://www.prada.com'},
              {id: '13', name: 'Neiman Marcus', url: 'https://www.neimanmarcus.com'},
              {id: '14', name: 'Saks Fifth Avenue', url: 'https://www.saksfifthavenue.com'},
              {id: '15', name: 'The Real Real', url: 'https://www.therealreal.com'},
              {id: '16', name: 'Hermès', url: 'https://www.hermes.com'},
              {id: '17', name: "Bloomingdale's", url: 'https://www.bloomingdales.com'},
              {id: '18', name: 'Burberry', url: 'https://us.burberry.com'},
              {id: '19', name: 'SSENSE', url: 'https://www.ssense.com'},
              {id: '20', name: 'Bergdorf Goodman', url: 'https://www.bergdorfgoodman.com'},
              {id: '21', name: 'Gilt', url: 'https://www.gilt.com'},
              {id: '22', name: 'Rue La La', url: 'https://www.ruelala.com'},
            ],
          };
        }
        return persistedState;
      },
      partialize: state => ({
        bookmarks: state.bookmarks,
        history: state.history,
        collections: state.collections,
        recentSearches: state.recentSearches,
        defaultShoppingSites: state.defaultShoppingSites,
        quickShopSites: state.quickShopSites,
        tabs: state.tabs,
        currentTabId: state.currentTabId,
        productInteractions: state.productInteractions,
        cartHistory: state.cartHistory,
        aiShoppingAssistantSuggestions: state.aiShoppingAssistantSuggestions,
        hasAiSuggestionsLoaded: state.hasAiSuggestionsLoaded,
        aiSuggestionsCachedAt: state.aiSuggestionsCachedAt,
        trackingConsent: state.trackingConsent,
        // Derived metrics (persisted)
        timeToActionLog: state.timeToActionLog,
        // Sync state (persisted for offline support)
        lastSyncTimestamp: state.lastSyncTimestamp,
        pendingChanges: state.pendingChanges,
        // Track when history was cleared to prevent server restore
        _historyClearedAt: state._historyClearedAt,
      }),
      // MULTI-ACCOUNT: Use a merge function that completely replaces persisted state
      // Default shallow merge doesn't work well with multi-account switching
      merge: (persistedState, currentState) => {
        // CRITICAL: When switching users, we need to COMPLETELY replace the state
        // If persistedState is null/empty (new user), we MUST clear existing data
        // to prevent User A's data from leaking to User B
        if (persistedState && typeof persistedState === 'object' && Object.keys(persistedState as object).length > 0) {
          // console.log('[ShoppingStore] Merging persisted state with', Object.keys(persistedState as object).length, 'keys');
          return {
            ...currentState,
            ...(persistedState as object),
          };
        }
        // No persisted state = new user or empty storage
        // Return fresh state with empty arrays to prevent data leakage
        // console.log('[ShoppingStore] No persisted state - returning fresh state');
        return {
          ...currentState,
          // Reset all user-specific data to prevent leakage
          bookmarks: [],
          history: [],
          collections: [],
          tabs: [],
          currentTabId: null,
          recentSearches: [],
          productInteractions: [],
          cartHistory: [],
          aiShoppingAssistantSuggestions: [],
          hasAiSuggestionsLoaded: false,
          aiSuggestionsCachedAt: null,
          timeToActionLog: [],
          savedAddresses: [],
          savedCards: [],
          lastSyncTimestamp: null,
          pendingChanges: {
            bookmarks: [],
            deletedBookmarkUrls: [],
            history: [],
            collections: [],
            deletedCollectionIds: [],
            cartHistory: [],
          },
          _historyClearedAt: null,
        };
      },
      onRehydrateStorage: () => state => {
        if (state) {
          // console.log('[ShoppingStore] Rehydration complete, tabs:', state.tabs?.length || 0, 'bookmarks:', state.bookmarks?.length || 0);
          state.setHasHydrated(true);
        }
      },
    },
  ),
);
