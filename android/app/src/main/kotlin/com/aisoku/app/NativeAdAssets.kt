package com.aisoku.app

import android.content.Context
import android.graphics.Color
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import com.google.android.gms.ads.nativead.AdChoicesView
import com.google.android.gms.ads.nativead.NativeAdView

internal fun Context.dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

internal fun Context.assetText(value: String?, size: Float = 12f, limit: Int? = null): TextView = TextView(this).apply {
    setTextColor(Color.rgb(32, 32, 32))
    textSize = size
    includeFontPadding = false
    text = if (value != null && limit != null && value.length > limit) value.take(limit) + "…" else value
    visibility = if (value.isNullOrBlank()) View.GONE else View.VISIBLE
}

internal fun Context.icon(drawable: android.graphics.drawable.Drawable?): ImageView = ImageView(this).apply {
    setImageDrawable(drawable)
    scaleType = ImageView.ScaleType.FIT_CENTER
    visibility = if (drawable == null) View.GONE else View.VISIBLE
}

internal fun NativeAdView.addChoices(context: Context) {
    val choices = AdChoicesView(context)
    addView(choices, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, context.dp(24), android.view.Gravity.TOP or android.view.Gravity.END))
    adChoicesView = choices
}

internal fun View.measureAtWidth(width: Int) {
    measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
}
