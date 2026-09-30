import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/news_item.dart';
import '../models/topic_source_article.dart';
import '../services/ad_consent_service.dart';
import '../services/hidden_sites_service.dart';
import '../services/monetization_analytics_service.dart';
import '../services/topic_source_service.dart';
import '../widgets/news_home_feed_dialogs.dart';
import '../widgets/news_home_home.dart';
import '../widgets/rss_discovery_sheet.dart';
import '../widgets/scrollable_category_tabs.dart';
import '../widgets/topic_source_sheet.dart';
import 'news_detail_page.dart';
import 'news_home_controller.dart';
import 'settings_page.dart';

class NewsHomePage extends StatefulWidget {
  const NewsHomePage({super.key});

  @override
  State<NewsHomePage> createState() => _NewsHomePageState();
}

class _NewsHomePageState extends State<NewsHomePage> {
  late final NewsHomeController _controller;
  bool _isFirstFrame = true;
  Timer? _hideSiteSnackTimer;
  PageController? _pageController;
  int _lastSyncedCategoryIndex = -1;
  String? _lastSyncedCategoryName;
  int? _programmaticTargetIndex;

  @override
  void initState() {
    super.initState();

    _controller = NewsHomeController();
    _controller.addListener(_onControllerChanged);

    // UIの描画（Skeleton）を最優先するため、データの初期化は最初のフレーム描画後に開始する
    WidgetsBinding.instance.addPostFrameCallback((_) {
      AdConsentService.instance.start();
      MonetizationAnalyticsService.instance.start();
      if (mounted) {
        setState(() {
          _isFirstFrame = false;
        });
      }
      _controller.initialize();
    });
  }

  void _onControllerChanged() {
    if (!mounted) {
      return;
    }

    if (_pageController != null && _pageController!.hasClients) {
      final int targetIndex = _controller.selectedCategoryIndex;
      final String? targetName =
          _controller.categories.isNotEmpty &&
              targetIndex >= 0 &&
              targetIndex < _controller.categories.length
          ? _controller.categories[targetIndex]
          : null;

      if (_lastSyncedCategoryIndex != targetIndex) {
        final bool isReorder =
            targetName != null &&
            targetName == _lastSyncedCategoryName &&
            _lastSyncedCategoryIndex != -1;

        _lastSyncedCategoryIndex = targetIndex;
        _lastSyncedCategoryName = targetName;

        if (_pageController!.page?.round() != targetIndex) {
          _programmaticTargetIndex = targetIndex;
          if (isReorder) {
            // 並べ替え時は一瞬のちらつきを防ぐため即時同期する
            _pageController!.jumpToPage(targetIndex);
            if (_programmaticTargetIndex == targetIndex) {
              _programmaticTargetIndex = null;
            }
          } else {
            // 通常のカテゴリ切替はアニメーションさせる
            _pageController!
                .animateToPage(
                  targetIndex,
                  duration: const Duration(milliseconds: 300),
                  curve: Curves.easeInOut,
                )
                .then((_) {
                  if (mounted && _programmaticTargetIndex == targetIndex) {
                    _programmaticTargetIndex = null;
                  }
                });
          }
        }
      } else {
        // インデックスが変わっていない場合も名前を同期（念のため）
        _lastSyncedCategoryName = targetName;
      }
    }

    setState(() {});
  }

  void _openNews(NewsItem news) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => NewsDetailPage(
          title: news.title,
          description: news.description,
          url: news.url,
          category: _controller.categoryForNews(news),
          articleId: news.articleId,
          sourceName: news.category,
          isSaved: _controller.savedUrls.contains(news.url),
          topicSubject: news.topicSubject,
          topicEvent: news.topicEvent,
          topicFacts: news.topicFacts,
          topicThreadTitle: news.threadTitle,
          topicCreationMode: news.topicCreationMode,
          topicId: news.isNewsData ? news.articleId : null,
        ),
      ),
    );
  }

  /*
  void _onTopicLongPress(NewsItem news) {
    showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(title: Text(news.title)),
            ListTile(
              title: const Text('ソース ＞'),
              onTap: () => Navigator.pop(context, 'sources'),
            ),
          ],
        ),
      ),
    ).then((source) async {
      if (source == null || !mounted) return;
      final next = await showModalBottomSheet<String>(
        context: context,
        builder: (_) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(title: Text(source.sourceName), subtitle: Text(source.title)),
              ListTile(
                title: const Text('ソースをブラウザで開く'),
                onTap: () => Navigator.pop(context, 'open'),
              ),
              ListTile(
                title: const Text('この媒体をRSS登録'),
                onTap: () => Navigator.pop(context, 'rss'),
              ),
            ],
          ),
        ),
      );
      if (next == 'open' && mounted) {
        await launchUrl(Uri.parse(source.url), mode: LaunchMode.externalApplication);
      }
      if (next == 'rss' && mounted) await _exploreRss(source.toNewsItem());
    });
  }

  ).then((action) async {
      if (action != 'sources' || news.articleId == null || !mounted) return;
      final source = await showModalBottomSheet<TopicSourceArticle>(
        context: context,
        isScrollControlled: true,
        builder: (_) => TopicSourceSheet(
          topicTitle: news.title,
          load: () => const TopicSourceService().fetch(news.articleId!),
        ),
      );
      if (source == null || !mounted) return;
      final next = await showModalBottomSheet<String>(
        context: context,
        builder: (_) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                title: Text(source.sourceName),
                subtitle: Text(source.title),
              ),
              ListTile(
                title: const Text('ソースをブラウザで開く'),
                onTap: () => Navigator.pop(context, 'open'),
              ),
              ListTile(
                title: const Text('この媒体をRSS登録'),
                onTap: () => Navigator.pop(context, 'rss'),
              ),
            ],
          ),
        ),
      );
      if (next == 'open' && mounted) _openNews(source.toNewsItem());
      if (next == 'rss' && mounted) await _exploreRss(source.toNewsItem());
    });
  }

  */

  void _onTopicLongPress(NewsItem news) {
    if (news.articleId == null) return;
    showModalBottomSheet<TopicSourceArticle>(
      context: context,
      isScrollControlled: true,
      builder: (_) => TopicSourceSheet(
        topicTitle: news.title,
        load: () => const TopicSourceService().fetch(news.articleId!),
      ),
    ).then((source) async {
      if (source == null || !mounted) return;
      final next = await showModalBottomSheet<String>(
        context: context,
        builder: (_) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                title: Text(source.sourceName),
                subtitle: Text(source.title),
              ),
              ListTile(
                title: const Text('ソースをブラウザで開く'),
                onTap: () => Navigator.pop(context, 'open'),
              ),
              ListTile(
                title: const Text('この媒体をRSS登録'),
                onTap: () => Navigator.pop(context, 'rss'),
              ),
            ],
          ),
        ),
      );
      if (next == 'open' && mounted) {
        await launchUrl(
          Uri.parse(source.url),
          mode: LaunchMode.externalApplication,
        );
      }
      if (next == 'rss' && mounted) await _exploreRss(source.toNewsItem());
    });
  }

  // ignore: unused_element
  void _onNewsLongPress(NewsItem news) {
    showModalBottomSheet(
      context: context,
      builder: (context) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(Icons.rss_feed),
                title: const Text('このサイトをRSS登録'),
                onTap: () {
                  Navigator.pop(context);
                  _exploreRss(news);
                },
              ),
              ListTile(
                leading: const Icon(Icons.visibility_off_outlined),
                title: const Text('このサイトを非表示にする'),
                onTap: () {
                  Navigator.pop(context);
                  _hideSite(news);
                },
              ),
              ListTile(
                leading: const Icon(Icons.copy),
                title: const Text('URLをコピー'),
                onTap: () {
                  Navigator.pop(context);
                  _copyUrl(news);
                },
              ),
              ListTile(
                leading: const Icon(Icons.share),
                title: const Text('共有'),
                onTap: () {
                  Navigator.pop(context);
                  _shareNews(news);
                },
              ),
            ],
          ),
        );
      },
    );
  }

  void _hideSite(NewsItem news) {
    final host = HiddenSitesService.normalizeHost(news.url);
    final siteName = news.category;
    final displayName = siteName.isNotEmpty ? siteName : host;

    _controller.hideSite(news);

    _hideSiteSnackTimer?.cancel();
    ScaffoldMessenger.of(context).hideCurrentSnackBar();

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('$displayNameの記事を非表示にしました'),
        duration: const Duration(seconds: 3),
        action: SnackBarAction(
          label: '元に戻す',
          onPressed: () {
            _hideSiteSnackTimer?.cancel();
            _controller.undoHideSite(host);
          },
        ),
      ),
    );

    _hideSiteSnackTimer = Timer(const Duration(seconds: 3), () {
      if (!mounted) return;
      ScaffoldMessenger.of(context).hideCurrentSnackBar();
    });
  }

  void _copyUrl(NewsItem news) {
    Clipboard.setData(ClipboardData(text: news.url));
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('URLをコピーしました')));
  }

  void _shareNews(NewsItem news) {
    Share.share('${news.title}\n${news.url}');
  }

  Future<void> _exploreRss(NewsItem news) async {
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => RssDiscoverySheet(
        articleUrl: news.url,
        sourceName: news.category,
        isRegistered: _controller.isRssFeedRegistered,
        addFeed: _controller.addFeed,
        onRegistered: () {
          if (!mounted) return;
          ScaffoldMessenger.of(context).hideCurrentSnackBar();
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text('RSSに登録しました')));
        },
      ),
    );
  }

  Future<void> _addFeed() async {
    final feed = await NewsHomeFeedDialogs.showAddFeed(context);

    if (feed == null) {
      return;
    }

    try {
      await _controller.addFeed(feed);

      if (!mounted) {
        return;
      }

      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('RSSを追加しました')));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('RSSの追加に失敗しました: $e'),
          backgroundColor: Colors.red.shade800,
        ),
      );
    }
  }

  Future<void> _deleteFeed(int index) async {
    final feed = _controller.userFeeds[index];

    final shouldDelete = await NewsHomeFeedDialogs.showDeleteFeed(
      context,
      feed.name,
    );

    if (!shouldDelete) {
      return;
    }

    await _controller.removeFeed(index);

    if (!mounted) {
      return;
    }

    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('RSSを削除しました')));
  }

  Widget _buildHomePage() {
    if (_controller.categories.isEmpty) {
      return NewsHomeHome(
        isLoading: _controller.isLoading,
        errorMessage: _controller.errorMessage,
        newsList: _controller.newsList,
        savedUrls: _controller.savedUrls,
        categoryName: 'default',
        scrollPositionVersion: 0,
        onReload: _controller.refreshNews,
        onLoadMore: _controller.loadMoreCurrentCategory,
        onSave: _controller.toggleSaved,
        onNewsTap: _openNews,
        onNewsLongPress: _onTopicLongPress,
      );
    }

    _pageController ??= PageController(
      initialPage: _controller.selectedCategoryIndex,
    );
    if (_lastSyncedCategoryIndex == -1) {
      _lastSyncedCategoryIndex = _controller.selectedCategoryIndex;
    }

    return PageView.builder(
      controller: _pageController,
      itemCount: _controller.categories.length,
      onPageChanged: (index) {
        if (_programmaticTargetIndex != null) {
          if (index == _programmaticTargetIndex) {
            _programmaticTargetIndex = null;
          }
          // プログラム移動中の他ページ（中間ページ等）の通知は無視する
          return;
        }
        if (index != _controller.selectedCategoryIndex) {
          _lastSyncedCategoryIndex = index;
          _controller.setCategoryIndex(index);
        }
      },
      itemBuilder: (context, index) {
        final category = _controller.categories[index];
        return NewsHomeHome(
          isLoading: _controller.isCategoryLoading(category),
          errorMessage: _controller.getCategoryError(category),
          newsList: _controller.getNewsForCategory(category),
          savedUrls: _controller.savedUrls,
          categoryName: category,
          scrollPositionVersion: _controller.getScrollVersionForCategory(
            category,
          ),
          onReload: _controller.refreshNews,
          onLoadMore: _controller.loadMoreCurrentCategory,
          onSave: _controller.toggleSaved,
          onNewsTap: _openNews,
          onNewsLongPress: _onTopicLongPress,
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final scaffold = Scaffold(
      appBar: AppBar(
        elevation: 0,
        centerTitle: false,
        title: const Text(
          'AIニュース掲示板',
          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 22),
        ),
        actions: [
          IconButton(
            onPressed: () => Navigator.of(context)
                .push(
                  MaterialPageRoute<void>(
                    builder: (_) => SettingsPage(
                      controller: _controller,
                      onNewsTap: _openNews,
                      onNewsLongPress: _onTopicLongPress,
                      onAddFeed: _addFeed,
                      onDeleteFeed: _deleteFeed,
                    ),
                  ),
                )
                .then((_) => _controller.reloadHiddenSites()),
            icon: const Icon(Icons.settings_outlined),
            tooltip: '設定',
          ),
          if (!_isFirstFrame)
            IconButton(
              onPressed: (_controller.isLoading || _controller.isRefreshing)
                  ? null
                  : _controller.refreshNews,
              icon: const Icon(Icons.refresh),
              tooltip: 'ニュースを更新',
            ),
        ],
        bottom: !_isFirstFrame
            ? PreferredSize(
                preferredSize: const Size.fromHeight(48),
                child: ScrollableCategoryTabs(
                  categories: _controller.categories,
                  selectedIndex: _controller.selectedCategoryIndex,
                  selectedCategoryName:
                      _controller.categories.isNotEmpty &&
                          _controller.selectedCategoryIndex >= 0 &&
                          _controller.selectedCategoryIndex <
                              _controller.categories.length
                      ? _controller.categories[_controller
                            .selectedCategoryIndex]
                      : '',
                  onTabSelected: _controller.setCategoryIndex,
                  onReorder: _controller.reorderCategories,
                ),
              )
            : null,
      ),
      body: _buildHomePage(),
    );

    return scaffold;
  }

  @override
  void dispose() {
    _hideSiteSnackTimer?.cancel();
    _controller.removeListener(_onControllerChanged);
    _controller.dispose();
    _pageController?.dispose();
    super.dispose();
  }
}
