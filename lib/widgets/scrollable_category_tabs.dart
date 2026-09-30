import 'dart:ui';

import 'package:flutter/material.dart';

class ScrollableCategoryTabs extends StatefulWidget {
  final List<String> categories;
  final int selectedIndex;
  final String selectedCategoryName;
  final ValueChanged<int> onTabSelected;
  final ReorderCallback? onReorder;

  const ScrollableCategoryTabs({
    super.key,
    required this.categories,
    required this.selectedIndex,
    required this.selectedCategoryName,
    required this.onTabSelected,
    this.onReorder,
  });

  @override
  State<ScrollableCategoryTabs> createState() => _ScrollableCategoryTabsState();
}

class _ScrollableCategoryTabsState extends State<ScrollableCategoryTabs> {
  final ScrollController _scrollController = ScrollController();
  final Map<int, GlobalKey> _tabKeys = {};
  bool _showLeftArrow = false;
  bool _showRightArrow = false;
  final double _threshold = 5.0;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _updateArrowVisibility();
      _scrollToSelected(animate: false);
    });
  }

  @override
  void didUpdateWidget(ScrollableCategoryTabs oldWidget) {
    super.didUpdateWidget(oldWidget);
    final bool categoriesChanged = oldWidget.categories != widget.categories;
    final bool indexChanged = oldWidget.selectedIndex != widget.selectedIndex;

    if (indexChanged || categoriesChanged) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) {
          _updateArrowVisibility();
          // 初期ロード（カテゴリが空から入った時）はアニメーションしない
          final bool shouldAnimate = indexChanged && !categoriesChanged;
          _scrollToSelected(animate: shouldAnimate);
        }
      });
    }
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    _updateArrowVisibility();
  }

  void _updateArrowVisibility() {
    if (!_scrollController.hasClients) return;

    final double offset = _scrollController.offset;
    final double maxScroll = _scrollController.position.maxScrollExtent;
    final bool canScrollLeft = offset > _threshold;
    final bool canScrollRight = offset < maxScroll - _threshold;

    if (_showLeftArrow != canScrollLeft || _showRightArrow != canScrollRight) {
      setState(() {
        _showLeftArrow = canScrollLeft;
        _showRightArrow = canScrollRight;
      });
    }
  }

  void _scrollToSelected({bool animate = true}) {
    if (!_scrollController.hasClients) return;

    final key = _tabKeys[widget.selectedIndex];
    if (key == null || key.currentContext == null) return;

    final RenderBox? tabBox =
        key.currentContext!.findRenderObject() as RenderBox?;
    if (tabBox == null) return;

    final RenderBox? viewportBox =
        _scrollController.position.context.storageContext.findRenderObject()
            as RenderBox?;
    if (viewportBox == null) return;

    final position = tabBox.localToGlobal(Offset.zero, ancestor: viewportBox);

    final double viewportWidth = viewportBox.size.width;
    final double tabWidth = tabBox.size.width;
    const double arrowWidth = 40.0;

    double targetOffset = _scrollController.offset;

    // 選択タブの左端が、左矢印領域（または左端）より左にある場合
    if (position.dx < arrowWidth) {
      targetOffset = _scrollController.offset + position.dx - arrowWidth;
    }
    // 選択タブの右端が、右矢印領域（または右端）より右にある場合
    else if (position.dx + tabWidth > viewportWidth - arrowWidth) {
      targetOffset =
          _scrollController.offset +
          (position.dx + tabWidth) -
          (viewportWidth - arrowWidth);
    }

    targetOffset = targetOffset.clamp(
      0.0,
      _scrollController.position.maxScrollExtent,
    );

    if ((targetOffset - _scrollController.offset).abs() > 1.0) {
      if (animate) {
        _scrollController.animateTo(
          targetOffset,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeInOut,
        );
      } else {
        _scrollController.jumpTo(targetOffset);
      }
    }
  }

  void _scrollForward() {
    if (!_scrollController.hasClients) return;
    final target = (_scrollController.offset + 120.0).clamp(
      0.0,
      _scrollController.position.maxScrollExtent,
    );
    _scrollController.animateTo(
      target,
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeInOut,
    );
  }

  void _scrollBackward() {
    if (!_scrollController.hasClients) return;
    final target = (_scrollController.offset - 120.0).clamp(
      0.0,
      _scrollController.position.maxScrollExtent,
    );
    _scrollController.animateTo(
      target,
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeInOut,
    );
  }

  Widget _proxyDecorator(Widget child, int index, Animation<double> animation) {
    return AnimatedBuilder(
      animation: animation,
      builder: (BuildContext context, Widget? child) {
        final double animValue = Curves.easeInOut.transform(animation.value);
        final double elevation = lerpDouble(0, 6, animValue)!;
        return Material(
          elevation: elevation,
          color: Theme.of(context).cardColor,
          shadowColor: Colors.black.withAlpha((255 * 0.3).toInt()),
          child: child,
        );
      },
      child: child,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 48,
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: Theme.of(context).dividerColor, width: 1),
        ),
      ),
      child: Stack(
        children: [
          Theme(
            data: Theme.of(context).copyWith(
              canvasColor: Colors.transparent,
              shadowColor: Colors.transparent,
            ),
            child: ReorderableListView.builder(
              scrollController: _scrollController,
              scrollDirection: Axis.horizontal,
              onReorderItem: widget.onReorder ?? (oldIdx, newIdx) {},
              proxyDecorator: _proxyDecorator,
              buildDefaultDragHandles: false,
              itemCount: widget.categories.length,
              itemBuilder: (context, index) {
                final category = widget.categories[index];
                final isSelected = category == widget.selectedCategoryName;
                final isRss = category == 'RSS';
                final key = _tabKeys.putIfAbsent(index, () => GlobalKey());

                Widget tab = InkWell(
                  key: key,
                  onTap: () => widget.onTabSelected(index),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    height: 48,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      border: Border(
                        bottom: BorderSide(
                          color: isSelected ? Colors.blue : Colors.transparent,
                          width: 3,
                        ),
                      ),
                    ),
                    child: Text(
                      category,
                      style: TextStyle(
                        color: isSelected ? Colors.blue : Colors.grey,
                        fontWeight: isSelected
                            ? FontWeight.bold
                            : FontWeight.normal,
                        fontSize: 14,
                      ),
                    ),
                  ),
                );

                if (isRss) {
                  return Container(key: ValueKey(category), child: tab);
                }

                return ReorderableDelayedDragStartListener(
                  key: ValueKey(category),
                  index: index,
                  child: tab,
                );
              },
            ),
          ),
          if (_showLeftArrow)
            Positioned(
              left: 0,
              top: 0,
              bottom: 0,
              child: _buildArrowButton(isRight: false),
            ),
          if (_showRightArrow)
            Positioned(
              right: 0,
              top: 0,
              bottom: 0,
              child: _buildArrowButton(isRight: true),
            ),
        ],
      ),
    );
  }

  Widget _buildArrowButton({required bool isRight}) {
    final bg = Theme.of(context).scaffoldBackgroundColor;
    return Container(
      width: 40,
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: isRight ? Alignment.centerRight : Alignment.centerLeft,
          end: isRight ? Alignment.centerLeft : Alignment.centerRight,
          colors: [bg, bg.withAlpha(0)],
        ),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: isRight ? _scrollForward : _scrollBackward,
          child: Center(
            child: Text(
              isRight ? '›' : '‹',
              style: const TextStyle(
                fontSize: 24,
                color: Colors.blue,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
