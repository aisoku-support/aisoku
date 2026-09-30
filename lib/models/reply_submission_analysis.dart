import '../config/low_information_words.dart';

/// ユーザー投稿の入力内容を解析し、整形やAI返信の必要性を判定するクラス。
/// 状態を持たず、入力文字列から一貫した解析結果を導き出す純粋なロジックを担う。
class ReplySubmissionAnalysis {
  /// 解析対象の元のテキスト（トリム済み）
  final String text;

  /// 抽出されたアンカー番号（例: >>11 なら 11）
  final int? referencedNumber;

  /// 表示用の本文。アンカー部分を除去し、その直後の空白や改行を保持したもの。
  final String bodyForDisplay;

  /// 判定用の本文。アンカーを除去し、前後をトリムした純粋なメッセージ。
  final String bodyForCheck;

  /// アンカーのみの投稿（本文が空）かどうか。
  final bool isBareAnchor;

  /// 意味の薄い投稿（短すぎる、記号のみ、特定の単語のみ）かどうか。
  final bool isLowInformation;

  /// 質問（? または ？）を含むかどうか。
  final bool isQuestion;

  /// AIによる返信生成を行うべきかどうか。
  final bool shouldGenerateAiReply;

  ReplySubmissionAnalysis._({
    required this.text,
    required this.referencedNumber,
    required this.bodyForDisplay,
    required this.bodyForCheck,
    required this.isBareAnchor,
    required this.isLowInformation,
    required this.isQuestion,
    required this.shouldGenerateAiReply,
  });

  /// 与えられた投稿テキストを解析するファクトリメソッド。
  /// [originalText] はユーザーの生入力を想定（内部でトリムされる）。
  factory ReplySubmissionAnalysis.analyze(String originalText) {
    final text = originalText.trim();
    final referencedNumber = _extractReferencedReplyNumber(text);

    // アンカーを除去した純粋な本文（判定用）
    final bodyForCheck = _removeReplyReference(text);

    // 表示用の本文整形ロジック
    String bodyForDisplay = text;
    if (referencedNumber != null) {
      final anchorMatch = RegExp(r'^\s*>>\s*\d+').firstMatch(text);
      if (anchorMatch != null) {
        bodyForDisplay = text.substring(anchorMatch.end);
      }
    }

    // 本文が空白のみの場合は空文字として扱う
    final finalBodyForDisplay = bodyForDisplay.trim().isEmpty
        ? ''
        : bodyForDisplay;
    final isBareAnchor =
        finalBodyForDisplay.isEmpty && referencedNumber != null;

    final isLowInformation = !_isMeaningful(bodyForCheck);
    final isQuestion = bodyForCheck.contains('?') || bodyForCheck.contains('？');

    // AI返信要否の判定ロジック
    bool shouldGenerate = true;
    if (isBareAnchor) {
      // >>N だけの投稿 (bare anchor) は返信しない
      shouldGenerate = false;
    } else if (isLowInformation) {
      // 低情報判定された場合、アンカー付きの質問以外は返信しない
      if (referencedNumber != null && isQuestion) {
        shouldGenerate = true;
      } else {
        shouldGenerate = false;
      }
    }

    return ReplySubmissionAnalysis._(
      text: text,
      referencedNumber: referencedNumber,
      bodyForDisplay: finalBodyForDisplay,
      bodyForCheck: bodyForCheck,
      isBareAnchor: isBareAnchor,
      isLowInformation: isLowInformation,
      isQuestion: isQuestion,
      shouldGenerateAiReply: shouldGenerate,
    );
  }

  static int? _extractReferencedReplyNumber(String text) {
    final match = RegExp(r'^\s*>>\s*(\d+)').firstMatch(text);
    if (match == null) return null;
    return int.tryParse(match.group(1)!);
  }

  static String _removeReplyReference(String text) {
    return text.replaceFirst(RegExp(r'^\s*>>\s*\d+\s*'), '').trim();
  }

  static bool _isMeaningful(String text) {
    final cleaned = text.trim();
    if (cleaned.isEmpty) return false;
    if (cleaned.length == 1) return false;
    if (RegExp(r'^(.)\1+$').hasMatch(cleaned)) return false;
    if (lowInformationWords.contains(cleaned)) return false;
    return true;
  }
}
