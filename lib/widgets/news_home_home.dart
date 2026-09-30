import 'package:flutter/material.dart';

import 'package:flutter/rendering.dart' show ScrollDirection, ScrollCacheExtent;

import '../models/news_item.dart';
import '../widgets/news_card.dart';
import '../config/ad_mob_config.dart';
import '../models/ad_identity.dart';
import '../services/native_ad_slot.dart';
import 'native_ad_card.dart';

class NewsHomeHome extends StatefulWidget {
  final bool isLoading;
  final String? errorMessage;
  final List<NewsItem> newsList;
  final Set<String> savedUrls;
  final String categoryName; // 追加：現在のカテゴリ名
  final int scrollPositionVersion;
  final Future<void> Function() onReload;
  final VoidCallback onLoadMore;
  final Future<void> Function(NewsItem news) onSave;
  final void Function(NewsItem news) onNewsTap;
  final void Function(NewsItem news) onNewsLongPress;
  @visibleForTesting
  final NativeAdSlot Function(AdIdentity)? adSlotFactory;

  const NewsHomeHome({
    super.key,
    required this.isLoading,
    required this.errorMessage,
    required this.newsList,
    required this.savedUrls,
    required this.categoryName, // 追加
    required this.scrollPositionVersion,
    required this.onReload,
    required this.onLoadMore,
    required this.onSave,
    required this.onNewsTap,
    required this.onNewsLongPress,
    this.adSlotFactory,
  });

  @override
  State<NewsHomeHome> createState() => _NewsHomeHomeState();
}

class _NewsHomeHomeState extends State<NewsHomeHome>
    with TickerProviderStateMixin {
  AnimationController? _skeletonController;
  final Map<int, AnimationController> _revealControllers = {};
  bool _isRevealing = false;
  bool _showAnimation = false;
  bool _isUserScrolling = false;
  bool _didLoadMoreForCurrentScroll = false;
  final Map<String, ScrollController> _scrollControllers = {};
  final Map<int, NativeAdSlot> _nativeSlots = {};

  NativeAdSlot _slot(int position) => _nativeSlots.putIfAbsent(position, () {
    final identity = AdIdentity(
      adFormat: 'native',
      screen: 'news',
      placement: position == 0 ? 'newsTop' : 'newsInterval',
      category: widget.categoryName,
      position: position,
    );
    return widget.adSlotFactory?.call(identity) ??
        NativeAdSlot(identity: identity, unit: AdUnit.newsNative);
  });

  void _startTopAd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final width = context.size?.width ?? MediaQuery.sizeOf(context).width;
      _slot(0).load(width - 20, reason: 'newsTop');
    });
  }

  void _disposeNativeSlots() {
    for (final slot in _nativeSlots.values) {
      slot.dispose();
    }
    _nativeSlots.clear();
  }

  @override
  void initState() {
    super.initState();
    _slot(0);
    _startTopAd();

    // 初回フレーム後にアニメーションを開始するように調整
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        setState(() {
          _showAnimation = true;
        });
        _skeletonController = AnimationController(
          vsync: this,
          duration: const Duration(milliseconds: 1000),
        )..repeat(reverse: true);
      }
    });
  }

  @override
  void didUpdateWidget(NewsHomeHome oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.categoryName != widget.categoryName) {
      _disposeNativeSlots();
      _slot(0);
      _startTopAd();
    }
    if (oldWidget.categoryName != widget.categoryName ||
        oldWidget.scrollPositionVersion != widget.scrollPositionVersion) {
      _isUserScrolling = false;
      _didLoadMoreForCurrentScroll = false;
    }
    if (oldWidget.newsList.isEmpty &&
        widget.newsList.isNotEmpty &&
        !_isRevealing) {
      _startReveal();
    }
  }

  void _startReveal() {
    setState(() {
      _isRevealing = true;
    });

    const int revealCount = 10;
    const int staggerMs = 40;

    for (int i = 0; i < revealCount && i < widget.newsList.length; i++) {
      final controller = AnimationController(
        vsync: this,
        duration: const Duration(milliseconds: 200),
      );
      _revealControllers[i] = controller;

      Future.delayed(Duration(milliseconds: i * staggerMs), () {
        if (mounted) {
          controller.forward();
        }
      });
    }
  }

  @override
  void dispose() {
    _disposeNativeSlots();
    _skeletonController?.dispose();
    for (var c in _revealControllers.values) {
      c.dispose();
    }
    for (final controller in _scrollControllers.values) {
      controller.dispose();
    }
    super.dispose();
  }

  bool _handleScrollNotification(ScrollNotification notification) {
    if (notification.depth != 0) return false;

    if (notification is UserScrollNotification) {
      _isUserScrolling = notification.direction != ScrollDirection.idle;
      if (!_isUserScrolling) {
        _didLoadMoreForCurrentScroll = false;
      }
      return false;
    }

    if (notification is ScrollUpdateNotification &&
        _isUserScrolling &&
        !_didLoadMoreForCurrentScroll &&
        (notification.scrollDelta ?? 0) > 0 &&
        notification.metrics.extentAfter < 300) {
      _didLoadMoreForCurrentScroll = true;
      widget.onLoadMore();
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    if (widget.errorMessage != null && widget.newsList.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.error_outline, size: 60, color: Colors.grey),
              const SizedBox(height: 16),
              const Text(
                'ニュースを取得できませんでした',
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 10),
              Text(
                widget.errorMessage!,
                style: const TextStyle(color: Colors.grey, fontSize: 12),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 20),
              ElevatedButton.icon(
                onPressed: widget.onReload,
                icon: const Icon(Icons.refresh),
                label: const Text('もう一度試す'),
              ),
            ],
          ),
        ),
      );
    }

    if (widget.newsList.isEmpty && !widget.isLoading) {
      return const Center(
        child: Text(
          'ニュースがありません',
          style: TextStyle(color: Colors.grey, fontSize: 18),
        ),
      );
    }

    final int adFrequency = 10;

    // スケルトン表示時（初回描画）
    if (widget.newsList.isEmpty && widget.isLoading) {
      return ListView.builder(
        // スケルトン時も念のためキーを付与（ただし通常は不要）
        key: PageStorageKey<String>('news-skeleton-${widget.categoryName}'),
        padding: const EdgeInsets.fromLTRB(10, 4, 10, 20),
        physics: const NeverScrollableScrollPhysics(), // 初回描画負荷軽減
        itemCount: 7, // 画面内を埋める最小限（広告1 + ニュース6）
        itemBuilder: (context, index) {
          if (index == 0) {
            final slot = _slot(0);
            return NativeAdCard(key: GlobalObjectKey(slot), slot: slot);
          }

          final skeletonCard = const NewsCard(news: null);

          if (!_showAnimation || _skeletonController == null) {
            return skeletonCard;
          }

          return FadeTransition(
            opacity: Tween(begin: 0.4, end: 0.8).animate(_skeletonController!),
            child: skeletonCard,
          );
        },
      );
    }

    // 実データ表示時
    int totalItems =
        widget.newsList.length + 1 + widget.newsList.length ~/ adFrequency;
    final scrollKey = '${widget.categoryName}-${widget.scrollPositionVersion}';

    return RefreshIndicator(
      onRefresh: widget.onReload,
      child: NotificationListener<ScrollNotification>(
        onNotification: _handleScrollNotification,
        child: ListView.builder(
          // 重要：カテゴリごとに独立したスクロール位置を保持するためのキー
          key: PageStorageKey<String>('news-list-$scrollKey'),
          controller: _scrollControllers.putIfAbsent(
            scrollKey,
            () => ScrollController(),
          ),
          padding: const EdgeInsets.fromLTRB(10, 4, 10, 20),
          scrollCacheExtent: const ScrollCacheExtent.viewport(1),
          itemCount: totalItems,
          itemBuilder: (context, index) {
            if (index % (adFrequency + 1) == 0) {
              final position = index ~/ (adFrequency + 1) * adFrequency;
              final slot = _slot(position);
              return NativeAdCard(key: GlobalObjectKey(slot), slot: slot);
            }

            final int adsBefore = (index ~/ (adFrequency + 1)) + 1;
            final int newsIndex = index - adsBefore;

            if (newsIndex >= widget.newsList.length) {
              return const SizedBox.shrink();
            }

            final news = widget.newsList[newsIndex];
            return NewsCard(
              news: news,
              isSaved: widget.savedUrls.contains(news.url),
              onSave: () => widget.onSave(news),
              onTap: () => widget.onNewsTap(news),
              onLongPress: () => widget.onNewsLongPress(news),
              animation: _revealControllers[newsIndex],
            );
          },
        ),
      ),
    );
  }
}
