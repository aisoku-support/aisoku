import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:news_app/controllers/news_detail_controller.dart';
import 'package:news_app/models/ai_reply_report.dart';
import 'package:news_app/models/reply_item.dart';

ReplyItem reply(ReplyOrigin origin, {String? target}) => ReplyItem(
  text: '元の本文',
  type: origin == ReplyOrigin.user ? ReplyType.user : ReplyType.ai,
  name: 'name',
  id: 'resident',
  origin: origin,
  reportTargetId: target ?? AiReplyReport.localTargetId(),
);

NewsDetailController controller(Future<void> Function(AiReplyReport) save) =>
    NewsDetailController(
      articleTitle: 'title',
      articleBody: 'body',
      newsUrl: 'https://example.com/news',
      reportSaver: save,
    );

void main() {
  test('only AI replies are reportable', () {
    expect(reply(ReplyOrigin.sharedAi).canReport, isTrue);
    expect(reply(ReplyOrigin.localAi).canReport, isTrue);
    expect(reply(ReplyOrigin.user).canReport, isFalse);
    expect(
      () => AiReplyReport(
        reply: reply(ReplyOrigin.user),
        newsUrl: 'url',
        type: AiReplyReportType.other,
      ),
      throwsArgumentError,
    );
  });

  test(
    'shared identity is stable and separates article, chunk and position',
    () {
      final id = AiReplyReport.sharedTargetId('url', 2, 3);
      expect(id, AiReplyReport.sharedTargetId('url', 2, 3));
      expect({
        id,
        AiReplyReport.sharedTargetId('other', 2, 3),
        AiReplyReport.sharedTargetId('url', 3, 3),
        AiReplyReport.sharedTargetId('url', 2, 4),
      }, hasLength(4));
      final original = reply(ReplyOrigin.sharedAi, target: id);
      expect(original.copyWith(replyTo: 50).reportTargetId, id);
      expect(original.toJson().containsKey('reportTargetId'), isFalse);
      expect(
        ReplyItem.fromJson({...original.toJson(), 'reportTargetId': id})
            .reportTargetId,
        id,
      );
    },
  );

  test(
    'local identity survives copies without inheriting resident identity',
    () {
      final first = reply(ReplyOrigin.localAi);
      final second = reply(ReplyOrigin.localAi);
      expect(first.id, second.id);
      expect(first.reportTargetId, isNot(second.reportTargetId));
      expect(first.copyWith(replyTo: 12).reportTargetId, first.reportTargetId);
    },
  );

  test('payload contains only report fields and clears previous note', () {
    final item = reply(ReplyOrigin.sharedAi);
    final data = AiReplyReport(
      reply: item,
      newsUrl: 'url',
      type: AiReplyReportType.incorrectContent,
      note: 'previous',
    ).toJson();
    expect(data, {
      'report_target_id': item.reportTargetId,
      'news_url': 'url',
      'reply_text': '元の本文',
      'report_type': 'incorrect_content',
      'note': null,
    });
    for (final note in [null, '', 'line1\nline2', 'a' * 200]) {
      expect(
        AiReplyReport(
          reply: item,
          newsUrl: 'url',
          type: AiReplyReportType.other,
          note: note,
        ).note,
        note,
      );
    }
    expect(
      () => AiReplyReport(
        reply: item,
        newsUrl: 'url',
        type: AiReplyReportType.other,
        note: 'a' * 201,
      ),
      throwsArgumentError,
    );
  });

  test(
    'success is applied after saving, re-report preserves original text',
    () async {
      final saved = <AiReplyReport>[];
      final pending = Completer<void>();
      final c = controller((report) async {
        saved.add(report);
        await pending.future;
      });
      final item = reply(ReplyOrigin.sharedAi);
      c.replies.add(item);
      final result = c.reportReply(item, AiReplyReportType.other, note: 'note');
      expect(c.isReplyReported(item), isFalse);
      pending.complete();
      expect(await result, isTrue);
      expect(c.isReplyReported(item), isTrue);
      expect(c.replies.single.text, '元の本文');
      expect(
        await c.reportReply(item, AiReplyReportType.incorrectContent),
        isTrue,
      );
      expect(saved.last.targetId, saved.first.targetId);
      expect(saved.last.replyText, '元の本文');
      expect(saved.last.note, isNull);
      final fresh = controller((_) async {});
      expect(fresh.isReplyReported(item), isFalse);
      fresh.dispose();
      c.dispose();
    },
  );

  test(
    'failure is isolated, no automatic retry and manual retry succeeds',
    () async {
      var attempts = 0;
      final c = controller((_) async {
        if (++attempts == 1) throw StateError('failed');
      });
      final item = reply(ReplyOrigin.localAi);
      c.replies.add(item);
      expect(await c.reportReply(item, AiReplyReportType.other), isFalse);
      expect(c.isReplyReported(item), isFalse);
      expect(c.loadMoreErrorMessage, isNull);
      expect(c.isLoading, isFalse);
      expect(c.replies.single, same(item));
      expect(attempts, 1);
      expect(await c.reportReply(item, AiReplyReportType.other), isTrue);
      expect(c.isReplyReported(item), isTrue);
      c.dispose();
    },
  );
}
