enum ReplyType { ai, user }

enum ReplyOrigin { sharedAi, user, localAi }

class ReplyItem {
  final String text;
  final ReplyType type;
  final String name;
  final String id;
  final int? replyTo; // 返信先のレス番号
  final ReplyOrigin origin;
  final bool isDeleted;
  // 通報専用。共有キャッシュのJSONには保存しない。
  final String? reportTargetId;

  bool get canReport => type == ReplyType.ai && origin != ReplyOrigin.user;

  const ReplyItem({
    required this.text,
    required this.type,
    required this.name,
    required this.id,
    this.replyTo,
    this.origin = ReplyOrigin.sharedAi,
    this.isDeleted = false,
    this.reportTargetId,
  });

  Map<String, dynamic> toJson() {
    return {
      'text': text,
      'type': type.name,
      'name': name,
      'id': id,
      'replyTo': replyTo,
      'origin': origin.name,
      if (isDeleted) 'isDeleted': true,
    };
  }

  factory ReplyItem.fromJson(Map<String, dynamic> json) {
    final typeName = json['type']?.toString();
    final type = ReplyType.values.firstWhere(
      (value) => value.name == typeName,
      orElse: () => ReplyType.ai,
    );

    final originName = json['origin']?.toString();
    final origin = ReplyOrigin.values.firstWhere(
      (value) => value.name == originName,
      orElse: () =>
          type == ReplyType.user ? ReplyOrigin.user : ReplyOrigin.sharedAi,
    );

    return ReplyItem(
      text: json['text']?.toString() ?? '',
      type: type,
      name: json['name']?.toString() ?? '',
      id: json['id']?.toString() ?? '',
      replyTo: json['replyTo'] as int?,
      origin: origin,
      isDeleted: json['isDeleted'] == true,
      reportTargetId: json['reportTargetId'] as String?,
    );
  }

  ReplyItem copyWith({
    String? text,
    ReplyType? type,
    String? name,
    String? id,
    int? replyTo,
    ReplyOrigin? origin,
    bool? isDeleted,
    String? reportTargetId,
  }) {
    return ReplyItem(
      text: text ?? this.text,
      type: type ?? this.type,
      name: name ?? this.name,
      id: id ?? this.id,
      replyTo: replyTo ?? this.replyTo,
      origin: origin ?? this.origin,
      isDeleted: isDeleted ?? this.isDeleted,
      reportTargetId: reportTargetId ?? this.reportTargetId,
    );
  }
}
