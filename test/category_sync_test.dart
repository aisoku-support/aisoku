import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/pages/news_home_controller.dart';
import 'package:news_app/widgets/news_home_home.dart';
import 'package:news_app/widgets/scrollable_category_tabs.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Category Synchronization (Flicker Prevention)', () {
    testWidgets('並べ替え時に即時同期され、別カテゴリが表示されないこと', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});

      final controller = NewsHomeController(
        fetchNewsData: () async => [],
        fetchRssCache: (feeds) async => [],
      );

      controller.categories = ['トレンド', 'エンタメ', 'サブカル'];
      controller.selectedCategoryIndex = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: NewsHomePageMock(controller: controller)),
        ),
      );

      await tester.pump();

      // 現在選択されているべきカテゴリが表示されているか確認するヘルパー
      bool isCategoryVisible(String name) {
        return find.byKey(ValueKey(name)).evaluate().isNotEmpty;
      }

      String getSelectedTabName() {
        final homes = tester.widgetList<InkWell>(find.byType(InkWell));
        for (final inkWell in homes) {
          final container = inkWell.child as Container;
          final decoration = container.decoration as BoxDecoration;
          final border = decoration.border as Border;
          if (border.bottom.color == Colors.blue) {
            final text = container.child as Text;
            return text.data!;
          }
        }
        return '';
      }

      expect(isCategoryVisible('トレンド'), isTrue);
      expect(getSelectedTabName(), 'トレンド');

      // トレンド(0) を エンタメ(1) の位置へ移動
      controller.reorderCategories(0, 1);

      // notifyListeners() による即時同期を確認
      await tester.pump();

      expect(
        isCategoryVisible('トレンド'),
        isTrue,
        reason: '並べ替え直後のフレームで別のカテゴリが表示されています。ちらつきが発生しています。',
      );
      expect(
        getSelectedTabName(),
        'トレンド',
        reason: '並べ替え直後のフレームで別のタブが選択状態になっています。',
      );
    });

    testWidgets('2つ以上離れたカテゴリをタップした際、中間カテゴリが選択されないこと', (
      WidgetTester tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      final controller = NewsHomeController(
        fetchNewsData: () async => [],
        fetchRssCache: (feeds) async => [],
      );
      controller.categories = ['A', 'B', 'C', 'D'];
      controller.selectedCategoryIndex = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: NewsHomePageMock(controller: controller)),
        ),
      );
      await tester.pump();

      String getSelectedTabName() {
        final homes = tester.widgetList<InkWell>(find.byType(InkWell));
        for (final inkWell in homes) {
          final container = inkWell.child as Container;
          final decoration = container.decoration as BoxDecoration;
          final border = decoration.border as Border;
          if (border.bottom.color == Colors.blue) {
            final text = container.child as Text;
            return text.data!;
          }
        }
        return '';
      }

      expect(getSelectedTabName(), 'A');

      // 'C' (index 2) をタップ
      controller.setCategoryIndex(2);
      await tester.pump(); // rebuild発火
      expect(getSelectedTabName(), 'C');

      // PageView のアニメーションを進める。中間 'B' が選択されないことを確認
      for (int i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 40));
        expect(getSelectedTabName(), 'C', reason: '中間カテゴリが選択されました。');
      }

      // 最終的に落ち着くまで待機
      await tester.pump(const Duration(milliseconds: 500));
      expect(getSelectedTabName(), 'C');
    });

    testWidgets('アニメーション途中で別タブを連続タップしても正常に最終目的地に到達すること', (
      WidgetTester tester,
    ) async {
      SharedPreferences.setMockInitialValues({});
      final controller = NewsHomeController(
        fetchNewsData: () async => [],
        fetchRssCache: (feeds) async => [],
      );
      controller.categories = ['A', 'B', 'C', 'D'];
      controller.selectedCategoryIndex = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: NewsHomePageMock(controller: controller)),
        ),
      );
      await tester.pump();

      // C をタップ
      controller.setCategoryIndex(2);
      await tester.pump(const Duration(milliseconds: 100)); // アニメーション途中

      // D をタップ
      controller.setCategoryIndex(3);
      await tester.pump(); // Dへのアニメーション開始

      await tester.pump(const Duration(milliseconds: 1000));

      String getSelectedTabName() {
        final homes = tester.widgetList<InkWell>(find.byType(InkWell));
        for (final inkWell in homes) {
          final container = inkWell.child as Container;
          final decoration = container.decoration as BoxDecoration;
          final border = decoration.border as Border;
          if (border.bottom.color == Colors.blue) {
            final text = container.child as Text;
            return text.data!;
          }
        }
        return '';
      }

      expect(getSelectedTabName(), 'D');
    });

    testWidgets('ユーザースワイプ時は正常にControllerが更新されること', (WidgetTester tester) async {
      SharedPreferences.setMockInitialValues({});
      final controller = NewsHomeController(
        fetchNewsData: () async => [],
        fetchRssCache: (feeds) async => [],
      );
      controller.categories = ['A', 'B', 'C'];
      controller.selectedCategoryIndex = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: NewsHomePageMock(controller: controller)),
        ),
      );
      await tester.pump();

      // PageView をスワイプ (A -> B)
      // drag は pump を伴わないので明示的に pump する
      await tester.drag(find.byType(PageView), const Offset(-400, 0));
      await tester.pump(
        const Duration(milliseconds: 1000),
      ); // スワイプ後のアニメーション完了を待つ

      expect(controller.selectedCategoryIndex, 1);
      expect(controller.categories[controller.selectedCategoryIndex], 'B');
    });
  });
}

class NewsHomePageMock extends StatefulWidget {
  final NewsHomeController controller;
  const NewsHomePageMock({super.key, required this.controller});

  @override
  State<NewsHomePageMock> createState() => _NewsHomePageMockState();
}

class _NewsHomePageMockState extends State<NewsHomePageMock> {
  late final NewsHomeController _controller;
  PageController? _pageController;
  int _lastSyncedCategoryIndex = -1;
  String? _lastSyncedCategoryName;
  int? _programmaticTargetIndex;

  @override
  void initState() {
    super.initState();
    _controller = widget.controller;
    _controller.addListener(_onControllerChanged);
    _lastSyncedCategoryIndex = _controller.selectedCategoryIndex;
    if (_controller.categories.isNotEmpty && _lastSyncedCategoryIndex >= 0) {
      _lastSyncedCategoryName =
          _controller.categories[_lastSyncedCategoryIndex];
    }
  }

  void _onControllerChanged() {
    if (!mounted) return;
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
            _pageController!.jumpToPage(targetIndex);
            if (_programmaticTargetIndex == targetIndex) {
              _programmaticTargetIndex = null;
            }
          } else {
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
        _lastSyncedCategoryName = targetName;
      }
    }
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    if (_controller.categories.isEmpty) return Container();

    _pageController ??= PageController(
      initialPage: _controller.selectedCategoryIndex,
    );

    return Column(
      children: [
        ScrollableCategoryTabs(
          categories: _controller.categories,
          selectedIndex: _controller.selectedCategoryIndex,
          selectedCategoryName:
              _controller.categories.isNotEmpty &&
                  _controller.selectedCategoryIndex >= 0
              ? _controller.categories[_controller.selectedCategoryIndex]
              : '',
          onTabSelected: _controller.setCategoryIndex,
          onReorder: _controller.reorderCategories,
        ),
        Expanded(
          child: PageView.builder(
            controller: _pageController,
            itemCount: _controller.categories.length,
            onPageChanged: (index) {
              if (_programmaticTargetIndex != null) {
                if (index == _programmaticTargetIndex) {
                  _programmaticTargetIndex = null;
                }
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
                key: ValueKey(category),
                isLoading: false,
                errorMessage: null,
                newsList: const [],
                savedUrls: const {},
                categoryName: category,
                scrollPositionVersion: 0,
                onReload: () async {},
                onLoadMore: () {},
                onSave: (_) async {},
                onNewsTap: (_) {},
                onNewsLongPress: (_) {},
              );
            },
          ),
        ),
      ],
    );
  }
}
