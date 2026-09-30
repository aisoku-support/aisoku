import 'package:flutter/material.dart';

import 'native_ad_card.dart';

import '../controllers/news_detail_controller.dart';
import '../models/reply_item.dart';
import 'news_detail_reply_bottom.dart';
import 'news_detail_reply_entry.dart';
import 'ai_reply_report_sheet.dart';

class NewsDetailReplySheet extends StatefulWidget {
  final NewsDetailController controller;
  final double sheetSize;
  final double minSheetSize;
  final double middleSheetSize;
  final double maxSheetSize;
  final ValueChanged<double> onMoveSheet;
  final VoidCallback onToggleSheet;
  final GestureDragUpdateCallback onHeaderDragUpdate;
  final GestureDragEndCallback onHeaderDragEnd;
  final VoidCallback onShowReplyBox;
  final void Function(int replyNumber) onReply;
  final void Function(int replyNumber)? onDelete;
  final void Function(int number, ReplyItem reply, BuildContext context)?
  onMorePressed;
  final void Function(ScrollNotification notification)? onScroll;
  final double? availableHeight;
  final double reservedBottomHeight;
  final bool showHeader;

  const NewsDetailReplySheet({
    super.key,
    required this.controller,
    required this.sheetSize,
    required this.minSheetSize,
    required this.middleSheetSize,
    required this.maxSheetSize,
    required this.onMoveSheet,
    required this.onToggleSheet,
    required this.onHeaderDragUpdate,
    required this.onHeaderDragEnd,
    required this.onShowReplyBox,
    required this.onReply,
    this.onDelete,
    this.onMorePressed,
    this.onScroll,
    this.availableHeight,
    required this.reservedBottomHeight,
    this.showHeader = true,
  });

  @override
  State<NewsDetailReplySheet> createState() => NewsDetailReplySheetState();
}

class NewsDetailReplySheetState extends State<NewsDetailReplySheet> {
  late final ScrollController _scrollController;
  final GlobalKey _viewportKey = GlobalKey();

  // スクロール補正中のフラグ
  bool _isCorrecting = false;

  // プログラムによるジャンプ中のフラグ（無限スクロール発火を防ぐ）
  bool _isProgrammaticJump = false;

  // 補正予約フラグ
  bool _isCorrectionScheduled = false;

  // 操作世代番号（古い補正予約を無効化するため）
  int _scrollOperationCount = 0;
  bool _isUserScrollOperation = false;

  bool _suppressVisibilityUntilUserScroll = false;
  bool _visibilityCheckScheduled = false;

  /// レスオブジェクトごとのGlobalKey
  final Map<ReplyItem, GlobalKey> _itemKeys = {};

  @override
  void initState() {
    super.initState();
    // 安定したスクロール状態を維持するために ScrollController を永続化
    _scrollController = ScrollController(keepScrollOffset: false);
    widget.controller.addListener(_onControllerChanged);
  }

  void _onControllerChanged() {
    if (widget.controller.pendingJumpNumber != null) {
      final target = widget.controller.pendingJumpNumber!;
      // 成功後にコントローラー側で pendingJumpNumber がクリアされる
      _performJump(target);
    }
    _scheduleVisibilityCheck();
  }

  GlobalKey _getKey(ReplyItem reply) {
    return _itemKeys.putIfAbsent(reply, () => GlobalKey());
  }

  Future<void> _performJump(int targetNumber) async {
    if (_isProgrammaticJump ||
        targetNumber < 1 ||
        targetNumber > widget.controller.replies.length) {
      return;
    }
    _isProgrammaticJump = true;
    _scrollOperationCount++; // ジャンプ開始時に世代を更新して古い補正予約を無効化
    _suppressVisibilityUntilUserScroll = true;

    try {
      final reply = widget.controller.replies[targetNumber - 1];
      final key = _getKey(reply);

      // 1. もし現在 build されていない（画面から遠い）場合
      if (key.currentContext == null) {
        final double viewport = _scrollController.position.hasContentDimensions
            ? _scrollController.position.viewportDimension
            : 500.0;

        // ターゲットを中央付近に持ってくるように見積もる。
        // 上方向ジャンプでの消失を防ぐため、 multiplier は少し控えめ（100.0）にする。
        final double estimate = (targetNumber - 1) * 100.0 - (viewport / 2);
        final double clampedEstimate = estimate.clamp(
          0,
          _scrollController.position.maxScrollExtent,
        );

        _scrollController.jumpTo(clampedEstimate);

        // build が完了するまで待機
        await WidgetsBinding.instance.endOfFrame;

        // 2回目のあがき: まだ null なら 0 または max へ飛ばす（極端な位置ならビルドされる可能性が高い）
        if (key.currentContext == null) {
          if (targetNumber <= 5) {
            _scrollController.jumpTo(0);
          } else if (targetNumber >= widget.controller.replies.length - 2) {
            _scrollController.jumpTo(
              _scrollController.position.maxScrollExtent,
            );
          }
          await WidgetsBinding.instance.endOfFrame;
        }
      }

      final context = key.currentContext;

      // 2. build されたか確認してスクロール
      if (context != null && context.mounted) {
        await Scrollable.ensureVisible(
          context,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeInOut,
          alignment: 0.1,
        );
        widget.controller.setJumpSuccess();
      } else {
        widget.controller.cancelJump('Context not found after nudge');
      }
    } catch (e) {
      widget.controller.cancelJump('Error: $e');
    } finally {
      _isProgrammaticJump = false;
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onControllerChanged);
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final parentHeight =
        widget.availableHeight ?? MediaQuery.of(context).size.height;
    final sheetHeight = parentHeight * widget.sheetSize;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        widget.controller.threadAds.setWidth(
          (_viewportKey.currentContext?.size?.width ??
                  MediaQuery.sizeOf(context).width) -
              28,
        );
      }
    });
    _scheduleVisibilityCheck();

    return Positioned(
      left: 0,
      right: 0,
      bottom: 0,
      height: sheetHeight,
      child: Material(
        elevation: 18,
        color: Theme.of(context).scaffoldBackgroundColor,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            if (widget.showHeader)
              GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTap: widget.onToggleSheet,
                onVerticalDragUpdate: widget.onHeaderDragUpdate,
                onVerticalDragEnd: widget.onHeaderDragEnd,
                child: Padding(
                  padding: const EdgeInsets.only(top: 10, bottom: 10),
                  child: Column(
                    children: [
                      Container(
                        width: 42,
                        height: 5,
                        decoration: BoxDecoration(
                          color: Colors.grey.shade400,
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        child: Stack(
                          alignment: Alignment.center,
                          children: [
                            // 中央寄せのタイトル
                            const Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Icon(Icons.chat_bubble_outline),
                                SizedBox(width: 8),
                                Text(
                                  'AI住人の反応',
                                  style: TextStyle(
                                    fontSize: 18,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ],
                            ),
                            // 右側の開閉アイコン（位置は維持）
                            const Align(
                              alignment: Alignment.centerRight,
                              child: Icon(Icons.keyboard_arrow_up),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            if (widget.showHeader) const Divider(height: 1),
            // 2. レス一覧（スクロール領域）
            Expanded(
              child: Stack(
                children: [
                  SelectionArea(
                    child: Scrollbar(
                      controller: _scrollController,
                      thumbVisibility: true,
                      child: NotificationListener<ScrollNotification>(
                        onNotification: (notification) {
                          if (notification is ScrollStartNotification) {
                            _isUserScrollOperation =
                                notification.dragDetails != null;
                            if (_isUserScrollOperation) {
                              _scrollOperationCount++;
                            }
                          }

                          if (notification is ScrollUpdateNotification &&
                              notification.dragDetails != null) {
                            _suppressVisibilityUntilUserScroll = false;
                          }
                          _scheduleVisibilityCheck();
                          if (widget.onScroll != null) {
                            widget.onScroll!(notification);
                          }

                          // 1. 通常のスクロール中（末尾に近づいた場合）
                          if (notification is ScrollUpdateNotification) {
                            final metrics = notification.metrics;

                            // 下方向へのスクロールであり、かつ末尾に近い場合
                            // プログラムによるジャンプ中は無限スクロールを抑制
                            if (!_isProgrammaticJump &&
                                (notification.scrollDelta ?? 0) > 0 &&
                                metrics.extentAfter < 200) {
                              if (!widget.controller.isLoading &&
                                  !widget.controller.isGenerating) {
                                widget.controller.loadMoreReplies();
                              }
                            }
                          }

                          // 2. 既に末尾にいる状態でさらに下へスクロール（オーバースクロール）しようとした場合
                          if (notification is OverscrollNotification) {
                            // dragDetails がある場合はユーザーの直接操作
                            // overscroll > 0 は下端方向への引き
                            if (!_isProgrammaticJump &&
                                notification.dragDetails != null &&
                                notification.overscroll > 0) {
                              if (!widget.controller.isLoading &&
                                  !widget.controller.isGenerating) {
                                widget.controller.loadMoreReplies();
                              }
                            }
                          }

                          if (notification is ScrollEndNotification) {
                            if (_isUserScrollOperation &&
                                !_isProgrammaticJump) {
                              // 手動スクロール終了時だけ末尾余白の補正を予約する。
                              _scheduleScrollCorrection();
                            }
                            _isUserScrollOperation = false;
                          }
                          return false;
                        },
                        child: KeyedSubtree(
                          key: _viewportKey,
                          child: CustomScrollView(
                            key: const PageStorageKey('ai_replies_list'),
                            controller: _scrollController,
                            physics: const ClampingScrollPhysics(),
                            slivers: [
                              if (widget.controller.threadAds.topSlot != null)
                                SliverToBoxAdapter(
                                  child: Padding(
                                    padding: const EdgeInsets.fromLTRB(
                                      14,
                                      12,
                                      14,
                                      0,
                                    ),
                                    child: SelectionContainer.disabled(
                                      child: NativeAdCard(
                                        key: GlobalObjectKey(
                                          widget.controller.threadAds.topSlot!,
                                        ),
                                        slot: widget
                                            .controller
                                            .threadAds
                                            .topSlot!,
                                        onEnteredViewport: () => widget
                                            .controller
                                            .threadAds
                                            .markEntered(
                                              widget
                                                  .controller
                                                  .threadAds
                                                  .topSlot!,
                                            ),
                                      ),
                                    ),
                                  ),
                                ),

                              // A. 既存レス一覧
                              SliverPadding(
                                padding: const EdgeInsets.fromLTRB(
                                  14,
                                  12,
                                  14,
                                  0,
                                ),
                                sliver: SliverList(
                                  delegate: SliverChildBuilderDelegate(
                                    (context, index) {
                                      if (index >=
                                          widget.controller.replies.length) {
                                        return null;
                                      }
                                      final reply =
                                          widget.controller.replies[index];
                                      final number = index + 1;
                                      final adSlot = widget.controller.threadAds
                                          .slotAt(index);

                                      final rKey = _getKey(reply);

                                      return NewsDetailReplyEntry(
                                        adWidget: adSlot == null
                                            ? null
                                            : NativeAdCard(
                                                key: GlobalObjectKey(adSlot),
                                                slot: adSlot,
                                                onEnteredViewport: () => widget
                                                    .controller
                                                    .threadAds
                                                    .markEntered(adSlot),
                                              ),
                                        replyKey: rKey,
                                        reply: reply,
                                        number: number,
                                        adPlacement: widget
                                            .controller
                                            .adPlacements[index],
                                        generatingMessage: widget.controller
                                            .getGeneratingMessageFor(reply.id),
                                        onReply: () => widget.onReply(number),
                                        isReported: widget.controller
                                            .isReplyReported(reply),
                                        onReport: reply.canReport
                                            ? () {
                                                showModalBottomSheet<void>(
                                                  context: context,
                                                  isScrollControlled: true,
                                                  builder: (_) =>
                                                      AiReplyReportSheet(
                                                        onSubmit:
                                                            (
                                                              type,
                                                              note,
                                                            ) => widget
                                                                .controller
                                                                .reportReply(
                                                                  reply,
                                                                  type,
                                                                  note: note,
                                                                ),
                                                      ),
                                                );
                                              }
                                            : null,
                                        onDelete:
                                            reply.origin == ReplyOrigin.user &&
                                                !reply.isDeleted &&
                                                widget.onDelete != null
                                            ? () => widget.onDelete!(number)
                                            : null,
                                        onAnchorTap: (target) {
                                          widget.controller.recordAnchorTap(
                                            number,
                                          );
                                          widget.controller.requestJump(
                                            target,
                                            sourceNumber: number,
                                          );
                                        },
                                        onMorePressed:
                                            widget.onMorePressed != null
                                            ? (context) =>
                                                  widget.onMorePressed!(
                                                    number,
                                                    reply,
                                                    context,
                                                  )
                                            : null,
                                      );
                                    },
                                    childCount:
                                        widget.controller.replies.length,
                                  ),
                                ),
                              ),

                              // B. 生成中表示（安定した配置のために常に SliverToBoxAdapter を使用）
                              SliverPadding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 14,
                                ),
                                sliver: SliverToBoxAdapter(
                                  child: SelectionContainer.disabled(
                                    child: NewsDetailReplyBottom(
                                      isGenerating:
                                          widget.controller.isGenerating,
                                      isLoading: widget.controller.isLoading,
                                      sharedLoadingMessage: widget
                                          .controller
                                          .sharedLoadingMessage,
                                      loadMoreErrorMessage: widget
                                          .controller
                                          .loadMoreErrorMessage,
                                      onRetry: widget
                                          .controller
                                          .retryLoadMoreReplies,
                                    ),
                                  ),
                                ),
                              ),

                              // C. 下部余白
                              SliverToBoxAdapter(
                                child: SizedBox(
                                  height: widget.reservedBottomHeight,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  // ジャンプ元へ戻るボタン
                  if (widget.controller.jumpSourceNumber != null)
                    Positioned(
                      right: 16,
                      bottom: 110,
                      child: _buildJumpBackButton(),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _scheduleVisibilityCheck() {
    if (_visibilityCheckScheduled) {
      return;
    }
    _visibilityCheckScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _visibilityCheckScheduled = false;
      if (!mounted ||
          _isProgrammaticJump ||
          _suppressVisibilityUntilUserScroll ||
          widget.sheetSize <= widget.minSheetSize + 0.001) {
        return;
      }
      _recordVisibleReplies();
    });
  }

  void _recordVisibleReplies() {
    final viewportContext = _viewportKey.currentContext;
    final viewportObject = viewportContext?.findRenderObject();
    if (viewportObject is! RenderBox || !viewportObject.attached) {
      return;
    }

    final viewportTop = viewportObject.localToGlobal(Offset.zero).dy;
    final viewportBottom = viewportTop + viewportObject.size.height;
    final visibleFractions = <int, double>{};

    // レス番号とオブジェクトの対応を現在のリストから取得
    final replies = widget.controller.replies;
    for (int i = 0; i < replies.length; i++) {
      final reply = replies[i];
      final number = i + 1;
      final key = _itemKeys[reply];
      if (key == null) continue;

      final context = key.currentContext;
      if (context == null || !context.mounted) {
        continue;
      }
      final itemObject = context.findRenderObject();
      if (itemObject is! RenderBox ||
          !itemObject.attached ||
          itemObject.size.height <= 0) {
        continue;
      }
      final itemTop = itemObject.localToGlobal(Offset.zero).dy;
      final itemBottom = itemTop + itemObject.size.height;
      final visibleHeight =
          (itemBottom.clamp(viewportTop, viewportBottom) -
                  itemTop.clamp(viewportTop, viewportBottom))
              .clamp(0.0, itemObject.size.height);
      visibleFractions[number] = visibleHeight / itemObject.size.height;
    }
    widget.controller.recordVisibleReplies(visibleFractions);
  }

  Widget _buildJumpBackButton() {
    return Material(
      color: Theme.of(context).cardColor.withAlpha((255 * 0.9).toInt()),
      elevation: 4,
      borderRadius: BorderRadius.circular(20),
      child: InkWell(
        onTap: widget.controller.jumpBack,
        borderRadius: BorderRadius.circular(20),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.undo, size: 16, color: Colors.blue),
              const SizedBox(width: 4),
              Text(
                '${widget.controller.jumpSourceNumber}へ戻る',
                style: const TextStyle(
                  color: Colors.blue,
                  fontSize: 13,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 必要に応じてスクロール位置の補正を予約する
  void _scheduleScrollCorrection() {
    if (_isCorrectionScheduled) {
      return;
    }

    _isCorrectionScheduled = true;
    final int generation = _scrollOperationCount;

    // 次のフレームで実行し、同期的なアニメーション開始を避ける
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }
      _isCorrectionScheduled = false;

      // 予約時と世代が異なる（新しい操作が始まっている）場合は中止
      if (generation != _scrollOperationCount) {
        return;
      }

      _correctScrollPositionIfNecessary();
    });
  }

  /// コンテンツの末尾（広告の終わり）へ引き戻す実際の処理
  Future<void> _correctScrollPositionIfNecessary() async {
    if (!_scrollController.hasClients || _isCorrecting || _isProgrammaticJump) {
      return;
    }

    final position = _scrollController.position;

    // ユーザーがドラッグ中などの場合は補正しない
    if (position.isScrollingNotifier.value) {
      return;
    }

    final maxScroll = position.maxScrollExtent;

    // 補正が必要なのは、maxScrollExtent（余白を含む終端）を超えてスクロールされた場合。
    // 手動操作でオーバースクロールした場合に、余白（reservedBottomHeight）が見える位置まで引き戻す。
    if (position.pixels > maxScroll + 10) {
      _isCorrecting = true;
      try {
        await _scrollController.animateTo(
          maxScroll,
          duration: const Duration(milliseconds: 400),
          curve: Curves.easeOutCubic,
        );
      } finally {
        _isCorrecting = false;
      }
    }
  }
}
