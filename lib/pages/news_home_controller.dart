import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/news_category_view_state.dart';
import '../models/news_item.dart';
import '../models/rss_feed.dart';
import '../services/news_cache_service.dart';
import '../services/topic_cache_service.dart';
import '../services/news_perf.dart';
import '../services/rss_service.dart';
import '../services/upstash_news_cache_service.dart';
import '../services/hidden_sites_service.dart';
import '../services/saved_thread_service.dart';

class NewsHomeController extends ChangeNotifier {
  NewsHomeController({
    Future<List<NewsItem>> Function()? fetchNewsData,
    Future<List<NewsItem>> Function(List<RssFeed>)? fetchRssCache,
    this._supabaseClient,
    this._rpcFetchPage,
  }) : _fetchNewsData = fetchNewsData ?? TopicCacheService.fetchNews,
       _fetchRssCache =
           fetchRssCache ??
           ((feeds) =>
               UpstashNewsCacheService.fetchNews(feeds, requireAllFeeds: true));
  final Future<List<NewsItem>> Function() _fetchNewsData;
  final Future<List<NewsItem>> Function(List<RssFeed>) _fetchRssCache;
  final Future<dynamic> Function(
    String category,
    DateTime? cursorCreatedAt,
    String? cursorTopicId,
  )?
  _rpcFetchPage;
  static const String _lastCategoryKey = 'last_selected_news_category';
  static const String _categoryOrderKey = 'reordered_news_categories';

  List<NewsItem> _allNewsList = [];
  List<NewsItem> _displayNewsList = [];
  final Map<String, List<NewsItem>> _categoryNewsLists = {};
  final NewsCategoryViewState _viewState = NewsCategoryViewState();

  final Map<String, bool> _categoryHasMore = {};
  final Map<String, bool> _categoryIsLoadingMore = {};
  final SupabaseClient? _supabaseClient;

  List<NewsItem> get newsList => _displayNewsList;
  final List<NewsItem> _savedNewsSnapshots = [];
  List<NewsItem> get allNews {
    final byUrl = <String, NewsItem>{
      for (final news in _savedNewsSnapshots) news.url: news,
      for (final news in _allNewsList) news.url: news,
    };
    return byUrl.values.toList();
  }

  int get currentCategoryScrollVersion {
    if (categories.isEmpty ||
        selectedCategoryIndex < 0 ||
        selectedCategoryIndex >= categories.length) {
      return 0;
    }
    return getScrollVersionForCategory(categories[selectedCategoryIndex]);
  }

  int getScrollVersionForCategory(String category) {
    return _viewState.getScrollVersion(category);
  }

  bool isCategoryLoading(String category) {
    final isRss = category == 'RSS';
    return _loadingSources.contains(isRss) &&
        getNewsForCategory(category).isEmpty;
  }

  String? getCategoryError(String category) {
    return _loadErrors[category == 'RSS'];
  }

  bool isLoading = true;
  bool isRefreshing = false;
  bool _isDisposed = false;
  int _newsLoadGeneration = 0;
  String? errorMessage;

  int selectedCategoryIndex = 0; // Top Tab用

  final Set<String> savedUrls = <String>{};
  final Set<String> hiddenHosts = <String>{};

  List<RssFeed> userFeeds = [];
  List<String> categories = [];

  String? categoryForNews(NewsItem news) {
    if (news.isNewsData) return news.appCategories.firstOrNull;
    if (userFeeds.any((feed) => feed.url == news.feedUrl)) return 'RSS';
    return null;
  }

  Future<void> initialize() async {
    NewsPerf.start();
    await Future.wait([_loadSavedNews(), _loadUserFeeds(), _loadHiddenSites()]);
    if (_isDisposed) return;
    await _updateCategories();
    await _restoreLastCategory();
    unawaited(
      NewsCacheService.touchRssFeeds(userFeeds.map((feed) => feed.url)),
    );
    final initialRss = categories[selectedCategoryIndex] == 'RSS';
    await loadNews(isRefresh: false, rssOnly: initialRss);
    if (_isDisposed) return;
    // 初期タブを表示した後で別系統の候補を準備する。
    unawaited(loadNews(isRefresh: false, rssOnly: !initialRss));
  }

  Future<void> _updateCategories() async {
    final prefs = await SharedPreferences.getInstance();
    final savedOrder = prefs.getStringList(_categoryOrderKey);

    final managed = NewsCategoryViewState.managedCategories;
    final List<String> newCategories = [];

    if (savedOrder != null && savedOrder.isNotEmpty) {
      // 保存された順序のうち、現在有効な運営カテゴリを採用
      for (final cat in savedOrder) {
        if (managed.contains(cat)) {
          newCategories.add(cat);
        }
      }
      // 保存順にない新しい運営カテゴリを追加（末尾へ）
      for (final cat in managed) {
        if (!newCategories.contains(cat)) {
          newCategories.add(cat);
        }
      }
    } else {
      // デフォルト順
      newCategories.addAll(managed);
    }

    if (userFeeds.isNotEmpty) {
      newCategories.add('RSS');
    }

    categories = newCategories;
  }

  void reorderCategories(int oldIndex, int newIndex) async {
    // RSSタブは末尾固定なので、RSS自身を動かしたりRSSの後ろに持ってくることはできない
    final rssIndex = categories.indexOf('RSS');
    if (rssIndex != -1) {
      if (oldIndex >= rssIndex || newIndex >= rssIndex) return;
    }

    if (oldIndex == newIndex) return;

    final String currentCategoryName = categories[selectedCategoryIndex];

    final String item = categories.removeAt(oldIndex);
    categories.insert(newIndex, item);

    // 選択中カテゴリの名前を基準にインデックスを更新して維持する
    selectedCategoryIndex = categories.indexOf(currentCategoryName);

    // 保存 (運営カテゴリのみ)
    final prefs = await SharedPreferences.getInstance();
    final managedOrder = categories
        .where((c) => NewsCategoryViewState.managedCategories.contains(c))
        .toList();
    await prefs.setStringList(_categoryOrderKey, managedOrder);

    notifyListeners();
  }

  void setCategoryIndex(int index) {
    if (index < 0 || index >= categories.length) return;
    selectedCategoryIndex = index;
    _saveLastCategory();
    _applyFilteredNews(isInitializing: false);
  }

  Future<void> _restoreLastCategory() async {
    final prefs = await SharedPreferences.getInstance();
    final lastCategory = prefs.getString(_lastCategoryKey);

    if (lastCategory != null) {
      final index = categories.indexOf(lastCategory);
      if (index != -1) {
        selectedCategoryIndex = index;
        debugPrint('[News] Restored category: $lastCategory at index $index');
      }
    }
  }

  Future<void> _saveLastCategory() async {
    if (selectedCategoryIndex < 0 ||
        selectedCategoryIndex >= categories.length) {
      return;
    }
    final prefs = await SharedPreferences.getInstance();
    final category = categories[selectedCategoryIndex];
    await prefs.setString(_lastCategoryKey, category);
  }

  void _applyFilteredNews({bool isInitializing = true}) {
    if (categories.isEmpty) return;
    final category = categories[selectedCategoryIndex];

    _displayNewsList = getNewsForCategory(category);

    errorMessage = getCategoryError(category);
    isLoading = isCategoryLoading(category);
    notifyListeners();

    debugPrint(
      '[News] Switched to category: $category, items: ${_displayNewsList.length}',
    );

    if (isInitializing) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        NewsPerf.mark('FIRST_FRAME');
        NewsPerf.stop();
      });
    }
  }

  List<NewsItem> getNewsForCategory(String category) {
    List<NewsItem> filtered;

    if (category == 'RSS') {
      final userUrls = userFeeds.map((f) => f.url).toSet();
      filtered = _allNewsList
          .where((n) => userUrls.contains(n.feedUrl))
          .toList();
    } else {
      filtered = _allNewsList
          .where((n) => n.isNewsData && n.appCategories.contains(category))
          .where((n) {
            final host = HiddenSitesService.normalizeHost(n.url);
            return !hiddenHosts.contains(host);
          })
          .toList();
    }

    final seen = <String>{};
    final seenIds = <String>{};
    var result = filtered.where((n) {
      final newUrl = seen.add(n.url);
      final newId = n.articleId == null || seenIds.add(n.articleId!);
      return newUrl && newId;
    }).toList();

    result.sort((a, b) {
      final dtA = a.sortDateTime;
      final dtB = b.sortDateTime;
      if (dtA == null && dtB == null) return 0;
      if (dtA == null) return 1;
      if (dtB == null) return -1;
      return dtB.compareTo(dtA);
    });

    if (NewsCategoryViewState.managedCategories.contains(category)) {
      _categoryNewsLists[category] = List<NewsItem>.unmodifiable(result);
      final visibleCount = _viewState.getVisibleCount(category);
      return result.take(visibleCount).toList();
    }
    return result;
  }

  void loadMoreCurrentCategory() {
    if (categories.isEmpty ||
        selectedCategoryIndex < 0 ||
        selectedCategoryIndex >= categories.length) {
      return;
    }
    final category = categories[selectedCategoryIndex];
    if (!NewsCategoryViewState.managedCategories.contains(category)) return;

    final allCategoryNews = _categoryNewsLists[category];
    if (allCategoryNews == null ||
        _displayNewsList.length >= allCategoryNews.length) {
      if (_categoryHasMore[category] != false) {
        unawaited(_loadMoreRpc(category));
      }
      return;
    }

    _viewState.loadMore(category, allCategoryNews.length);
    final nextVisibleCount = _viewState.getVisibleCount(category);
    _displayNewsList = allCategoryNews.take(nextVisibleCount).toList();
    notifyListeners();
  }

  Future<void> _loadMoreRpc(String category) async {
    if (_categoryHasMore[category] == false ||
        _categoryIsLoadingMore[category] == true) {
      return;
    }

    _categoryIsLoadingMore[category] = true;
    notifyListeners();

    try {
      final categoryNewsIncludingHidden = _allNewsList
          .where((n) => n.isNewsData && n.appCategories.contains(category))
          .toList();

      categoryNewsIncludingHidden.sort((a, b) {
        final dtA = a.sortDateTime;
        final dtB = b.sortDateTime;
        if (dtA == null && dtB == null) return 0;
        if (dtA == null) return 1;
        if (dtB == null) return -1;
        return dtB.compareTo(dtA);
      });

      DateTime? cursorCreatedAt;
      String? cursorTopicId;

      if (categoryNewsIncludingHidden.isNotEmpty) {
        final lastItem = categoryNewsIncludingHidden.last;
        cursorCreatedAt = lastItem.createdAt;
        cursorTopicId = lastItem.articleId;
      }

      final response = _rpcFetchPage != null
          ? await _rpcFetchPage(category, cursorCreatedAt, cursorTopicId)
          : await (_supabaseClient ?? Supabase.instance.client).rpc(
              'get_public_topic_page',
              params: {
                'p_category': category,
                'p_cursor_created_at': cursorCreatedAt?.toIso8601String(),
                'p_cursor_topic_id': cursorTopicId,
                'p_limit': 50,
              },
            );

      if (response is List) {
        final List<NewsItem> fetchedItems = [];
        for (final item in response) {
          if (item is Map<String, dynamic>) {
            fetchedItems.add(TopicCacheService.parseTopic(item));
          }
        }

        if (fetchedItems.length < 50) {
          _categoryHasMore[category] = false;
        } else {
          _categoryHasMore[category] = true;
        }

        if (fetchedItems.isNotEmpty) {
          final existingIds = _allNewsList.map((n) => n.articleId).toSet();
          final newItems = fetchedItems
              .where(
                (n) =>
                    n.articleId == null || !existingIds.contains(n.articleId),
              )
              .toList();

          _allNewsList.addAll(newItems);

          final currentVisible = _viewState.getVisibleCount(category);
          _viewState.loadMore(category, currentVisible + 1);
        } else {
          _categoryHasMore[category] = false;
        }

        _applyFilteredNews(isInitializing: false);
      } else {
        _categoryHasMore[category] = false;
      }
    } catch (e) {
      debugPrint('[News] get_public_topic_page error: $e');
    } finally {
      _categoryIsLoadingMore[category] = false;
      notifyListeners();
    }
  }

  bool get mounted => hasListeners;

  Future<void> _loadSavedNews() async {
    final prefs = await SharedPreferences.getInstance();
    savedUrls
      ..clear()
      ..addAll(prefs.getStringList('saved_news_urls') ?? []);
    _savedNewsSnapshots
      ..clear()
      ..addAll(await SavedThreadService.loadArticles(savedUrls));
    notifyListeners();
  }

  Future<void> _loadHiddenSites() async {
    hiddenHosts.clear();
    hiddenHosts.addAll(await HiddenSitesService.getHiddenHosts());
    notifyListeners();
  }

  Future<void> hideSite(NewsItem news) async {
    final host = HiddenSitesService.normalizeHost(news.url);
    final name = news.category;
    hiddenHosts.add(host);
    await HiddenSitesService.hide(host, name);
    _applyFilteredNews(isInitializing: false);
  }

  Future<void> undoHideSite(String host) async {
    if (hiddenHosts.remove(host)) {
      await HiddenSitesService.unhide(host);
      _applyFilteredNews(isInitializing: false);
    }
  }

  Future<void> toggleSaved(NewsItem news) async {
    final prefs = await SharedPreferences.getInstance();
    if (savedUrls.contains(news.url)) {
      savedUrls.remove(news.url);
      _savedNewsSnapshots.removeWhere((item) => item.url == news.url);
      notifyListeners();
      await SavedThreadService.delete(news.url);
    } else {
      savedUrls.add(news.url);
      _savedNewsSnapshots.removeWhere((item) => item.url == news.url);
      _savedNewsSnapshots.add(news);
      notifyListeners();
      await SavedThreadService.saveArticle(news);
    }
    await prefs.setStringList('saved_news_urls', savedUrls.toList());
  }

  Future<void> reloadHiddenSites() async {
    await _loadHiddenSites();
    _applyFilteredNews(isInitializing: false);
  }

  Future<void> _loadUserFeeds() async {
    final prefs = await SharedPreferences.getInstance();
    final savedNames = prefs.getStringList('rss_feed_names');
    final savedUrls = prefs.getStringList('rss_feed_urls');

    if (savedNames == null ||
        savedUrls == null ||
        savedNames.length != savedUrls.length) {
      userFeeds = [];
      return;
    }

    userFeeds = List.generate(
      savedNames.length,
      (index) => RssFeed(name: savedNames[index], url: savedUrls[index]),
    );
  }

  Future<void> saveUserFeeds() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(
      'rss_feed_names',
      userFeeds.map((f) => f.name).toList(),
    );
    await prefs.setStringList(
      'rss_feed_urls',
      userFeeds.map((f) => f.url).toList(),
    );
  }

  Future<List<NewsItem>> _fetchRssNews(List<RssFeed> feeds) async {
    final fetchFutures = feeds.map((feed) {
      return RssService.fetchNews(feed).catchError((e) {
        debugPrint('RSS取得エラー (${feed.name}): $e');
        return <NewsItem>[];
      });
    }).toList();
    final results = await Future.wait(fetchFutures);
    return results.expand((items) => items).toList();
  }

  Future<void> refreshNews() {
    return loadNews(resetCategoryViews: true);
  }

  Future<void> addFeed(RssFeed feed) async {
    // 既存URLチェック
    if (userFeeds.any((f) => f.url == feed.url)) {
      return;
    }

    try {
      await NewsCacheService.ensureRssFeedExists(feed.url, feed.name);
    } catch (e) {
      rethrow;
    }

    userFeeds = List<RssFeed>.from(userFeeds)..add(feed);
    await saveUserFeeds();
    await _updateCategories();
    notifyListeners();
    if (_loadingSources.contains(true)) {
      _reloadRssAfterLoad = true;
    } else {
      unawaited(loadNews(isRefresh: true, rssOnly: true));
    }
  }

  bool isRssFeedRegistered(String url) {
    return userFeeds.any((feed) => feed.url == url);
  }

  Future<void> removeFeed(int index) async {
    final removedFeed = userFeeds[index];
    userFeeds = List<RssFeed>.from(userFeeds)..removeAt(index);

    _allNewsList = _allNewsList
        .where((item) => item.feedUrl != removedFeed.url)
        .toList();

    await saveUserFeeds();
    await _updateCategories();

    // カテゴリ位置の調整
    if (selectedCategoryIndex >= categories.length) {
      selectedCategoryIndex = categories.length - 1;
    }

    _applyFilteredNews(isInitializing: false);
    notifyListeners();
  }

  final Map<bool, String> _loadErrors = {};
  final Set<bool> _loadingSources = {};
  bool _reloadRssAfterLoad = false;

  Future<void> loadNews({
    bool isRefresh = true,
    bool resetCategoryViews = false,
    bool? rssOnly,
  }) async {
    final rss = rssOnly ?? (categories[selectedCategoryIndex] == 'RSS');
    if (_loadingSources.contains(rss)) return;
    _loadingSources.add(rss);
    final generation = _newsLoadGeneration;
    if (isRefresh) isRefreshing = true;
    _loadErrors.remove(rss);
    isLoading = _displayNewsList.isEmpty;
    notifyListeners();
    try {
      List<NewsItem> incoming;
      var remoteSuccess = true;
      if (rss) {
        final feeds = List<RssFeed>.from(userFeeds);
        incoming = [];
        try {
          incoming = await _fetchRssCache(feeds);
        } catch (_) {
          /* ユーザーRSSのみ直接取得へフォールバック */
        }
        if (incoming.isEmpty) incoming = await _fetchRssNews(feeds);
        if (incoming.isEmpty) {
          incoming = await NewsCacheService.loadLocalCache(feeds);
        }
        final urls = userFeeds.map((f) => f.url).toSet();
        incoming = incoming
            .where((item) => urls.contains(item.feedUrl))
            .toList();
      } else {
        try {
          incoming = await _fetchNewsData();
        } catch (_) {
          remoteSuccess = false;
          incoming = _allNewsList.where((n) => n.isNewsData).toList();
          if (incoming.isEmpty) {
            incoming = await TopicCacheService.loadLocal();
          }
          if (incoming.isEmpty) _loadErrors[rss] = 'ニュースを取得できませんでした。';
        }
      }
      if (_isDisposed || generation != _newsLoadGeneration) return;
      if (!rss) {
        _categoryHasMore.clear();
        _categoryIsLoadingMore.clear();
      }
      final retained = _allNewsList
          .where((n) => rss ? n.isNewsData : !n.isNewsData)
          .toList();
      if (rss && isRefresh) {
        final merged = {
          for (final n in _allNewsList.where((n) => !n.isNewsData)) n.url: n,
        };
        for (final n in incoming) {
          merged[n.url] = n;
        }
        final urls = userFeeds.map((f) => f.url).toSet();
        incoming = merged.values
            .where((n) => urls.contains(n.feedUrl))
            .toList();
      }
      _allNewsList = [...retained, ...incoming];
      if (resetCategoryViews && remoteSuccess) {
        _viewState.resetForRefresh(
          rss ? ['RSS'] : NewsCategoryViewState.managedCategories.toList(),
        );
      }
      if (rss) await NewsCacheService.saveLocalCache(incoming);
    } catch (_) {
      _loadErrors[rss] = 'ニュースを取得できませんでした。';
    } finally {
      _loadingSources.remove(rss);
      if (!_isDisposed && generation == _newsLoadGeneration) {
        isRefreshing = false;
        _applyFilteredNews(isInitializing: !isRefresh);
        if (rss && _reloadRssAfterLoad) {
          _reloadRssAfterLoad = false;
          unawaited(loadNews(isRefresh: true, rssOnly: true));
        }
      }
    }
  }

  @override
  void dispose() {
    _isDisposed = true;
    _newsLoadGeneration++;
    super.dispose();
  }
}
