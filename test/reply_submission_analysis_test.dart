import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/models/reply_submission_analysis.dart';

void main() {
  group('ReplySubmissionAnalysis', () {
    test('1. 通常投稿', () {
      final analysis = ReplySubmissionAnalysis.analyze('こんにちは');
      expect(analysis.referencedNumber, isNull);
      expect(analysis.bodyForDisplay, 'こんにちは');
      expect(analysis.bodyForCheck, 'こんにちは');
      expect(analysis.isBareAnchor, isFalse);
      expect(analysis.shouldGenerateAiReply, isTrue);
    });

    test('2. >>11 本文', () {
      final analysis = ReplySubmissionAnalysis.analyze('>>11 こんにちは');
      expect(analysis.referencedNumber, 11);
      expect(analysis.bodyForDisplay, ' こんにちは');
      expect(analysis.bodyForCheck, 'こんにちは');
      expect(analysis.isBareAnchor, isFalse);
      expect(analysis.shouldGenerateAiReply, isTrue);
    });

    test('3. >>11\\n本文', () {
      final analysis = ReplySubmissionAnalysis.analyze('>>11\nこんにちは');
      expect(analysis.referencedNumber, 11);
      expect(analysis.bodyForDisplay, '\nこんにちは');
      expect(analysis.bodyForCheck, 'こんにちは');
      expect(analysis.isBareAnchor, isFalse);
    });

    test('4. >>11 のみ', () {
      final analysis = ReplySubmissionAnalysis.analyze('>>11');
      expect(analysis.referencedNumber, 11);
      expect(analysis.bodyForDisplay, '');
      expect(analysis.bodyForCheck, '');
      expect(analysis.isBareAnchor, isTrue);
      expect(analysis.shouldGenerateAiReply, isFalse);
    });

    test('5. >>11 ?', () {
      final analysis = ReplySubmissionAnalysis.analyze('>>11 ?');
      expect(analysis.referencedNumber, 11);
      expect(analysis.isQuestion, isTrue);
      expect(analysis.isLowInformation, isTrue);
      // アンカー付き質問は例外的に返信する仕様の維持
      expect(analysis.shouldGenerateAiReply, isTrue);
    });

    test('6. 単独 ?', () {
      final analysis = ReplySubmissionAnalysis.analyze('?');
      expect(analysis.isQuestion, isTrue);
      expect(analysis.isLowInformation, isTrue);
      expect(analysis.shouldGenerateAiReply, isFalse);
    });

    test('7. ？？？', () {
      final analysis = ReplySubmissionAnalysis.analyze('？？？');
      expect(analysis.isLowInformation, isTrue);
      expect(analysis.shouldGenerateAiReply, isFalse);
    });

    test('8. www', () {
      final analysis = ReplySubmissionAnalysis.analyze('www');
      expect(analysis.isLowInformation, isTrue);
      expect(analysis.shouldGenerateAiReply, isFalse);
    });

    test('9. 草', () {
      final analysis = ReplySubmissionAnalysis.analyze('草');
      expect(analysis.isLowInformation, isTrue);
      expect(analysis.shouldGenerateAiReply, isFalse);
    });

    test('10. 現在のLOW_INFORMATION固定語 (せやな)', () {
      final analysis = ReplySubmissionAnalysis.analyze('せやな');
      expect(analysis.isLowInformation, isTrue);
      expect(analysis.shouldGenerateAiReply, isFalse);
    });

    test('11. アンカー付きLOW_INFORMATION相当入力 (>>11 せやな)', () {
      final analysis = ReplySubmissionAnalysis.analyze('>>11 せやな');
      expect(analysis.referencedNumber, 11);
      expect(analysis.isLowInformation, isTrue);
      expect(analysis.isQuestion, isFalse);
      // 質問ではない低情報投稿は、アンカーがあっても返信しない仕様
      expect(analysis.shouldGenerateAiReply, isFalse);
    });

    test('12. アンカー番号を正しく抽出', () {
      expect(ReplySubmissionAnalysis.analyze('>>123').referencedNumber, 123);
      expect(
        ReplySubmissionAnalysis.analyze('  >>456  ').referencedNumber,
        456,
      );
    });

    test('13. アンカーなしでは番号なし', () {
      expect(ReplySubmissionAnalysis.analyze('hello').referencedNumber, isNull);
      expect(ReplySubmissionAnalysis.analyze('>11').referencedNumber, isNull);
    });

    test('14. アンカー直後の空白を保持', () {
      final analysis = ReplySubmissionAnalysis.analyze('>>11   本文');
      expect(analysis.bodyForDisplay, '   本文');
    });

    test('15. アンカー直後の改行を保持', () {
      final analysis = ReplySubmissionAnalysis.analyze('>>11\n\n本文');
      expect(analysis.bodyForDisplay, '\n\n本文');
    });

    test('16. AI返信対象の総合判定の維持', () {
      // 返信対象
      expect(
        ReplySubmissionAnalysis.analyze('テスト投稿').shouldGenerateAiReply,
        isTrue,
      );
      expect(
        ReplySubmissionAnalysis.analyze('>>1 なぜですか？').shouldGenerateAiReply,
        isTrue,
      );

      // 返信対象外
      expect(
        ReplySubmissionAnalysis.analyze('>>1').shouldGenerateAiReply,
        isFalse,
      );
      expect(
        ReplySubmissionAnalysis.analyze('わかる').shouldGenerateAiReply,
        isFalse,
      );
      expect(
        ReplySubmissionAnalysis.analyze('>>1 わかる').shouldGenerateAiReply,
        isFalse,
      );
    });
  });
}
