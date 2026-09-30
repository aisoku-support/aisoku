import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/models/news_category_view_state.dart';

void main() {
  group('NewsCategoryViewState', () {
    late NewsCategoryViewState viewState;

    setUp(() {
      viewState = NewsCategoryViewState();
    });

    test('1. 運営カテゴリは初期50件', () {
      expect(viewState.getVisibleCount('トレンド'), 50);
      expect(viewState.getVisibleCount('IT・ガジェット'), 50);
    });

    test('2. 候補が50件未満なら全件表示 (ただし内部的な visibleCount は 50 または 0)', () {
      expect(viewState.getVisibleCount('エンタメ'), 50);
      expect(viewState.isFullyLoaded('エンタメ', 30), true);
    });

    test('3. 50 → 100', () {
      viewState.loadMore('エンタメ', 200);
      expect(viewState.getVisibleCount('エンタメ'), 100);
    });

    test('4. 100 → 150', () {
      viewState.loadMore('サブカル', 200); // 50 -> 100
      viewState.loadMore('サブカル', 200); // 100 -> 150
      expect(viewState.getVisibleCount('サブカル'), 150);
    });

    test('5. 最終ページが50件未満なら残り全件 (内部的な件数としての確認)', () {
      viewState.loadMore('マネー', 120); // 50 -> 100
      viewState.loadMore('マネー', 120); // 100 -> 150
      expect(viewState.getVisibleCount('マネー'), 150);
      expect(viewState.isFullyLoaded('マネー', 120), true);
    });

    test('6. 全件表示後は増えない', () {
      viewState.loadMore('トレンド', 60); // 50 -> 100
      expect(viewState.getVisibleCount('トレンド'), 100);
      viewState.loadMore('トレンド', 60); // すでに 100 >= 60 なので増えないはず
      expect(viewState.getVisibleCount('トレンド'), 100);
    });

    test('7. カテゴリごとに表示件数を独立保持', () {
      viewState.loadMore('トレンド', 200);
      expect(viewState.getVisibleCount('トレンド'), 100);
      expect(viewState.getVisibleCount('エンタメ'), 50);
    });

    test('8. カテゴリを切り替えて戻っても件数維持 (状態がMapに保持されていることの確認)', () {
      viewState.loadMore('トレンド', 200);
      expect(viewState.getVisibleCount('トレンド'), 100);

      // 他のカテゴリを操作してもトレンドは維持される
      viewState.loadMore('エンタメ', 200);
      expect(viewState.getVisibleCount('トレンド'), 100);
    });

    test('9. resetで運営カテゴリは50件へ戻る', () {
      viewState.loadMore('トレンド', 200);
      expect(viewState.getVisibleCount('トレンド'), 100);
      viewState.resetForRefresh(['トレンド']);
      expect(viewState.getVisibleCount('トレンド'), 50);
    });

    test('10. RSSは50件制限を受けない (getVisibleCountが0を返す)', () {
      expect(viewState.getVisibleCount('RSS'), 0);
      viewState.loadMore('RSS', 200);
      expect(viewState.getVisibleCount('RSS'), 0);
    });

    test('11. 1カテゴリのloadMoreが他カテゴリへ影響しない', () {
      viewState.loadMore('トレンド', 200);
      expect(viewState.getVisibleCount('トレンド'), 100);
      expect(viewState.getVisibleCount('エンタメ'), 50);
    });

    test('12. resetで対象カテゴリのスクロール世代が更新される', () {
      expect(viewState.getScrollVersion('トレンド'), 0);
      expect(viewState.getScrollVersion('RSS'), 0);
      expect(viewState.getScrollVersion('その他'), 0);

      viewState.resetForRefresh(['トレンド', 'RSS', 'その他']);

      expect(viewState.getScrollVersion('トレンド'), 1);
      expect(viewState.getScrollVersion('RSS'), 1);
      expect(viewState.getScrollVersion('その他'), 0); // スクロールリセット対象外
    });
  });
}
