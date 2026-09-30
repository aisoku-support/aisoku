// ignore_for_file: prefer_initializing_formals

class NewsItem {
  final String _title;
  String get title =>
      isNewsData ? (threadTitle ?? representativeTitle ?? _title) : _title;
  final String url;
  final String time;
  final String category;
  final String description;
  final String feedUrl;
  final DateTime? publishedAt;
  final String? articleId;
  final List<String> newsdataCategories;
  final List<String> appCategories;
  final DateTime? fetchedAt;

  final DateTime? createdAt;
  final DateTime? firstSeenAt;
  final String? threadTitle;
  final String? representativeTitle;
  final String? topicSubject;
  final String? topicEvent;
  final List<String> topicFacts;
  final String? topicCreationMode;

  bool get isNewsData => articleId != null;

  const NewsItem({
    required String title,
    required this.url,
    required this.time,
    required this.category,
    this.description = '',
    required this.feedUrl,
    this.publishedAt,
    this.articleId,
    this.newsdataCategories = const [],
    this.appCategories = const [],
    this.fetchedAt,
    this.createdAt,
    this.firstSeenAt,
    this.threadTitle,
    this.representativeTitle,
    this.topicSubject,
    this.topicEvent,
    this.topicFacts = const [],
    this.topicCreationMode,
  }) : _title = title;

  DateTime? get sortDateTime {
    if (isNewsData) {
      return createdAt ?? firstSeenAt ?? publishedAt;
    }
    return publishedAt;
  }

  /// 表示用の日時を取得する。
  String get displayTime {
    if (isNewsData) {
      final dt = createdAt ?? firstSeenAt ?? publishedAt;
      if (dt == null) return time;

      final localDt = dt.isUtc ? dt.toLocal() : dt;
      final m = localDt.month.toString();
      final d = localDt.day.toString();
      final hh = localDt.hour.toString().padLeft(2, '0');
      final mm = localDt.minute.toString().padLeft(2, '0');

      return '$m/$d $hh:$mm';
    }

    if (publishedAt == null) {
      return time;
    }

    final localDt = publishedAt!.toLocal();
    final y = localDt.year.toString();
    final m = localDt.month.toString().padLeft(2, '0');
    final d = localDt.day.toString().padLeft(2, '0');
    final hh = localDt.hour.toString().padLeft(2, '0');
    final mm = localDt.minute.toString().padLeft(2, '0');

    return '$y/$m/$d $hh:$mm';
  }
}
