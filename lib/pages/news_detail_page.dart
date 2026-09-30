import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../controllers/news_detail_controller.dart';
import '../models/reply_item.dart';
import '../widgets/ai_reply_report_sheet.dart';
import '../widgets/news_detail_reply_input.dart';
import '../widgets/news_detail_reply_sheet.dart';
import '../widgets/reply_card.dart';

class NewsDetailPage extends StatefulWidget {
  final String title;
  final String url;
  final String description;
  final String? category;
  final String? articleId;
  final String? sourceName;
  final bool isSaved;
  final NewsDetailController? controller;
  final String? topicSubject;
  final String? topicEvent;
  final List<String> topicFacts;
  final String? topicThreadTitle;
  final String? topicCreationMode;
  final String? topicId;

  const NewsDetailPage({
    super.key,
    required this.title,
    required this.url,
    this.description = '',
    this.category,
    this.articleId,
    this.sourceName,
    this.isSaved = false,
    this.controller,
    this.topicSubject,
    this.topicEvent,
    this.topicFacts = const [],
    this.topicThreadTitle,
    this.topicCreationMode,
    this.topicId,
  });

  @override
  State<NewsDetailPage> createState() => _NewsDetailPageState();
}

class _NewsDetailPageState extends State<NewsDetailPage> {
  late final NewsDetailController _controller;

  final TextEditingController _commentController = TextEditingController();
  final GlobalKey<NewsDetailReplySheetState> _replySheetKey = GlobalKey();

  bool isReplyBoxVisible = false;

  bool _isPartialTabActive = false;
  double? _partialTabTop;
  int? _partialTabState;
  bool _waitingForForeground = false;
  bool _waitingForBack = false;
  VoidCallback? _pendingAction;

  bool _isLinkVisible = true;

  static const _customTabsChannel = MethodChannel('news_app/custom_tabs');

  Future<void> _handleMethodCall(MethodCall call) async {
    if (call.method == 'onPartialTabLayerUpdate') {
      final args = call.arguments as Map;
      if (mounted) {
        final newActive = args['active'] ?? false;
        final newTop = (args['top'] as int?)?.toDouble();
        final newState = args['state'] as int?;

        setState(() {
          _isPartialTabActive = newActive;
          if (_isPartialTabActive) {
            _partialTabTop = newTop;
            _partialTabState = newState;
          } else {
            _partialTabTop = null;
            _partialTabState = null;
          }
        });
      }
    } else if (call.method == 'onForegroundRestored') {
      if (_waitingForBack) {
        _waitingForBack = false;
        final navigator = Navigator.of(context);
        if (mounted) {
          navigator.pop();
        }
      } else if (_waitingForForeground) {
        _waitingForForeground = false;
        _showReplyBox();
      } else if (_pendingAction != null) {
        final action = _pendingAction!;
        _pendingAction = null;
        if (mounted) {
          action();
        }
      }
    }
  }

  void _handleScroll(ScrollNotification notification) {
    if (notification is ScrollUpdateNotification) {
      final delta = notification.scrollDelta ?? 0;
      final pixels = notification.metrics.pixels;

      // リスト最上部では必ず表示
      if (pixels <= 0) {
        if (!_isLinkVisible) {
          setState(() => _isLinkVisible = true);
        }
        return;
      }

      // 下方向スクロールで非表示、上方向で表示
      if (delta > 2.0 && _isLinkVisible && pixels > 20) {
        setState(() => _isLinkVisible = false);
      } else if (delta < -2.0 && !_isLinkVisible) {
        setState(() => _isLinkVisible = true);
      }
    }
  }

  Future<void> _launchPartialCustomTab() async {
    try {
      await _customTabsChannel.invokeMethod('launchPartialCustomTab', {
        'url': widget.url,
      });
    } on PlatformException catch (e) {
      debugPrint('Failed to launch partial custom tab: ${e.message}');
    }
  }

  // 定数：中間サイズ（画面比率）
  static const double _middleSheetSize = 0.50;

  // ヘッダー固定高（ピクセル）：AI住民の反応ヘッダーだけが見える高さ
  // 64pxに設定し、ヘッダー(~60px)と区切り線(1px)が収まるようにします。
  static const double _headerHeight = 64.0;

  // 現在のシートサイズ（画面比率）
  double _sheetSize = 0.1; // 初期値（build時に最小サイズへ調整される）
  bool _isFirstLayout = true;

  @override
  void initState() {
    super.initState();

    _controller =
        widget.controller ??
        NewsDetailController(
          articleTitle: widget.title,
          articleBody: widget.description,
          newsUrl: widget.url,
          newsCategory: widget.category,
          sourceName: widget.sourceName ?? '',
          isSaved: widget.isSaved,
          topicSubject: widget.topicSubject,
          topicEvent: widget.topicEvent,
          topicFacts: widget.topicFacts,
          topicThreadTitle: widget.topicThreadTitle,
          topicCreationMode: widget.topicCreationMode,
          topicId: widget.topicId,
        );

    _controller.addListener(_onControllerChanged);

    _controller.loadInitialReplies();

    _customTabsChannel.setMethodCallHandler(_handleMethodCall);
  }

  void _onControllerChanged() {
    if (!mounted) return;

    setState(() {
      if (_controller.isReadOnly) isReplyBoxVisible = false;
    });
  }

  void _showReplyActions(int number, ReplyItem reply, BuildContext context) {
    ReplyCard.showReplyActions(
      context: context,
      number: number,
      reply: reply,
      onReply: _controller.isReadOnly ? null : () => _replyTo(number),
      onDelete: reply.origin == ReplyOrigin.user && !reply.isDeleted
          ? () => _confirmDeleteComment(number)
          : null,
      onReport: reply.canReport
          ? () {
              showModalBottomSheet<void>(
                context: context,
                isScrollControlled: true,
                builder: (_) => AiReplyReportSheet(
                  onSubmit: (type, note) =>
                      _controller.reportReply(reply, type, note: note),
                ),
              );
            }
          : null,
      isReported: _controller.isReplyReported(reply),
    );
  }

  Future<void> _confirmDeleteComment(int number) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        content: const Text('このコメントを削除しますか？'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('キャンセル'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('削除'),
          ),
        ],
      ),
    );
    if (confirmed == true) await _controller.deleteUserComment(number);
  }

  void _handleMorePressed(int number, ReplyItem reply, BuildContext context) {
    if (_isPartialTabActive) {
      // タブが閉じ終わった後に前面でメニューを開くため、State自体のcontextをキャプチャする
      _pendingAction = () => _showReplyActions(number, reply, this.context);
      _customTabsChannel.invokeMethod('returnFromPartialTabForReply');
    } else {
      _showReplyActions(number, reply, context);
    }
  }

  void _onHeaderDragEnd(DragEndDetails details) {
    // スナップ処理なし：ユーザーが指を離した位置で止まる
  }

  void _showReplyBox() {
    if (_controller.isReadOnly) return;
    setState(() {
      isReplyBoxVisible = true;
    });
  }

  void _replyTo(int replyNumber) {
    if (_controller.isReadOnly) return;
    final reference = '>>$replyNumber\n';
    final currentValue = _commentController.value;
    final currentText = currentValue.text;
    final selection = currentValue.selection;
    final start = selection.isValid
        ? selection.start.clamp(0, currentText.length)
        : currentText.length;
    final end = selection.isValid
        ? selection.end.clamp(0, currentText.length)
        : currentText.length;
    final updatedText = currentText.replaceRange(start, end, reference);

    _commentController.value = TextEditingValue(
      text: updatedText,
      selection: TextSelection.collapsed(offset: start + reference.length),
    );

    setState(() {
      isReplyBoxVisible = true;
    });
  }

  void _hideReplyBox() {
    if (!isReplyBoxVisible) return;

    FocusManager.instance.primaryFocus?.unfocus();

    setState(() {
      isReplyBoxVisible = false;
    });
  }

  Future<void> _postComment() async {
    final text = _commentController.text.trim();

    if (text.isEmpty || _controller.isLoading || _controller.isGenerating) {
      return;
    }

    final success = await _controller.postComment(text);
    if (!success) return;

    _commentController.clear();

    setState(() {
      isReplyBoxVisible = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, result) async {
        if (didPop) return;

        final navigator = Navigator.of(context);

        if (_isPartialTabActive && !_waitingForBack && !_waitingForForeground) {
          setState(() {
            _waitingForBack = true;
          });
          try {
            await _customTabsChannel.invokeMethod(
              'returnFromPartialTabForReply',
            );
          } on PlatformException catch (e) {
            debugPrint('Error returning from tab on back: ${e.message}');
            setState(() {
              _waitingForBack = false;
            });
            if (mounted) navigator.pop();
          }
        } else {
          navigator.pop();
        }
      },
      child: Scaffold(
        appBar: AppBar(
          centerTitle: false,
          title: Text(
            widget.title,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
          ),
          elevation: 0,
        ),
        body: Column(
          children: [
            AnimatedSize(
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeInOut,
              alignment: Alignment.topCenter,
              child: _isLinkVisible
                  ? Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      child: Align(
                        alignment: Alignment.centerRight,
                        child: InkWell(
                          onTap: _launchPartialCustomTab,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 12),
                            child: Text(
                              '${Uri.tryParse(widget.url)?.host ?? '元記事'}で読む ↗',
                              style: TextStyle(
                                color: Theme.of(context).colorScheme.primary,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ),
                        ),
                      ),
                    )
                  : const SizedBox.shrink(),
            ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final bodyHeight = constraints.maxHeight;
                  final minSize = _headerHeight / bodyHeight;

                  // 初期レイアウト時、または画面サイズ変更で最小サイズを下回った場合の補正
                  double currentSheetSize = _sheetSize;
                  if (_isFirstLayout || _sheetSize < minSize - 0.001) {
                    currentSheetSize = minSize;
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (mounted) {
                        setState(() {
                          _sheetSize = minSize;
                          _isFirstLayout = false;
                        });
                      }
                    });
                  }

                  final bool showWriteButton = !_controller.isReadOnly;
                  final bool isButtonVisible =
                      showWriteButton && !isReplyBoxVisible;

                  // Positioned(bottom: 14) + SafeArea + SizedBox(height: 52) + 余裕(20)
                  final double safeAreaBottom = MediaQuery.of(context)
                      .padding
                      .bottom;
                  final double reservedHeight =
                      isButtonVisible || _controller.isReadOnly
                      ? (14 + 52 + 20 + safeAreaBottom)
                      : (safeAreaBottom + 16);

                  final sheetPixelHeight = bodyHeight * currentSheetSize;

                  // Partial Tab の位置計算 (logical pixel)
                  double? tabTopInStack;
                  if (_isPartialTabActive && _partialTabTop != null) {
                    final mediaQuery = MediaQuery.of(context);
                    final dpr = mediaQuery.devicePixelRatio;
                    final logicalTop = _partialTabTop! / dpr;
                    final appBarHeight =
                        Scaffold.of(context).appBarMaxHeight ?? 0;
                    // AppBar直下のAnimatedSize分を考慮
                    // ここでのtabTopは画面全体での座標なので、Stack内での座標に変換
                    // StackはExpanded内にある。
                    // 実際にはLayoutBuilder内部なので、Global座標からStackのTop(Global)を引く。
                    final RenderBox? box =
                        context.findRenderObject() as RenderBox?;
                    final double stackGlobalTop =
                        box?.localToGlobal(Offset.zero).dy ??
                        (appBarHeight + (_isLinkVisible ? 44.0 : 0.0));

                    tabTopInStack = logicalTop - stackGlobalTop;
                  }

                  void moveSheetTo(double size) {
                    final target = size.clamp(minSize, 1.0);
                    setState(() {
                      _sheetSize = target;
                    });
                  }

                  void toggleSheet() {
                    if (_sheetSize > minSize + 0.05) {
                      moveSheetTo(minSize);
                    } else {
                      moveSheetTo(_middleSheetSize);
                    }
                  }

                  void closeSheet() {
                    if (_sheetSize > minSize) {
                      moveSheetTo(minSize);
                    }
                  }

                  return Stack(
                    children: [
                      // ニュース記事表示領域（現在は空だが将来用）
                      const Positioned.fill(child: SizedBox.shrink()),

                      // ニュース部分へのインタラクションを検知するレイヤー
                      // コメント欄が開いているときだけ配置
                      if (_sheetSize > minSize + 0.01)
                        Positioned(
                          top: 0,
                          left: 0,
                          right: 0,
                          height: bodyHeight - sheetPixelHeight,
                          child: Listener(
                            // タップまたはドラッグ開始（PointerDown）でパネルを閉じる
                            // behavior: HitTestBehavior.translucent により、背面のレス画面へのスクロールも同時に通る
                            onPointerDown: (_) => closeSheet(),
                            behavior: HitTestBehavior.translucent,
                            child: const SizedBox.expand(),
                          ),
                        ),

                      NewsDetailReplySheet(
                        key: _replySheetKey,
                        controller: _controller,
                        sheetSize: 1.0,
                        minSheetSize: 0.0,
                        middleSheetSize: _middleSheetSize,
                        maxSheetSize: 1.0, // 最大比率を1.0（bodyHeight全体）に変更
                        availableHeight: bodyHeight,
                        onMoveSheet: moveSheetTo,
                        onToggleSheet: toggleSheet,
                        onHeaderDragUpdate: (details) {
                          final delta = details.delta.dy / bodyHeight;
                          final newSize = (_sheetSize - delta).clamp(
                            minSize,
                            1.0,
                          );
                          setState(() {
                            _sheetSize = newSize;
                          });
                        },
                        onHeaderDragEnd: _onHeaderDragEnd,
                        onShowReplyBox: _showReplyBox,
                        onReply: _replyTo,
                        onDelete: _confirmDeleteComment,
                        onMorePressed: _handleMorePressed,
                        onScroll: _handleScroll,
                        reservedBottomHeight: reservedHeight,
                        showHeader: false,
                      ),
                      if (isButtonVisible)
                        Positioned(
                          left: 14,
                          right: 14,
                          bottom: 14,
                          child: SafeArea(
                            top: false,
                            child: SizedBox(
                              height: 52,
                              child: ElevatedButton.icon(
                                onPressed: _showReplyBox,
                                icon: const Icon(Icons.edit),
                                label: const Text(
                                  '書き込む',
                                  style: TextStyle(
                                    fontSize: 17,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      if (_controller.isReadOnly)
                        Positioned(
                          left: 14,
                          right: 14,
                          bottom: 14,
                          child: SafeArea(
                            top: false,
                            child: Container(
                              height: 52,
                              alignment: Alignment.center,
                              decoration: BoxDecoration(
                                color: Theme.of(context).cardColor,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: const Text('このスレッドは終了しました'),
                            ),
                          ),
                        ),
                      if (isReplyBoxVisible && !_controller.isReadOnly)
                        () {
                          // 通常は 0 (bottom: 0)
                          // Partial Tab (50%) 表示中は、Tabの上端に合わせる
                          double bottomOffset = 0;
                          if (tabTopInStack != null &&
                              _partialTabState != 2 &&
                              _partialTabState != 5) {
                            bottomOffset = bodyHeight - tabTopInStack + 4;
                          }

                          return NewsDetailReplyInput(
                            controller: _commentController,
                            onSubmit: _postComment,
                            onTapOutside: _hideReplyBox,
                            isSubmitEnabled:
                                !_controller.isLoading &&
                                !_controller.isGenerating,
                            disabledMessage: _controller.isGenerating
                                ? 'AIが返信を生成しています。完了後に送信できます'
                                : null,
                            bottom: bottomOffset,
                          );
                        }(),

                      // Partial Custom Tab 用の小型ペンアイコン
                      // state 2: BOTTOM_SHEET_MAXIMIZED, 5: FULL_SCREEN
                      if (_isPartialTabActive &&
                          tabTopInStack != null &&
                          _partialTabState != 2 &&
                          _partialTabState != 5 &&
                          tabTopInStack > 10 &&
                          !isReplyBoxVisible)
                        () {
                          final penLogicalTop = tabTopInStack! - 50;

                          return Positioned(
                            top: penLogicalTop,
                            right: 20,
                            child: FloatingActionButton(
                              mini: true,
                              onPressed: () async {
                                _waitingForForeground = true;
                                try {
                                  await _customTabsChannel.invokeMethod(
                                    'returnFromPartialTabForReply',
                                  );
                                } on PlatformException catch (e) {
                                  debugPrint(
                                    'Error returning from tab: ${e.message}',
                                  );
                                  _waitingForForeground = false;
                                }
                              },
                              backgroundColor: Theme.of(context).primaryColor,
                              child: const Icon(
                                Icons.edit,
                                color: Colors.white,
                              ),
                            ),
                          );
                        }(),
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _controller.removeListener(_onControllerChanged);
    _controller.dispose();
    _commentController.dispose();
    super.dispose();
  }
}
