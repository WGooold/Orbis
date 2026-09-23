package dev.pi.remote

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp

/** 页面、控件与内容共用的尺寸规范；阴影不参与这些尺寸的计算。 */
internal object RemoteUi {
    val PagePadding = 20.dp
    val TouchTarget = 48.dp
    val IconButtonSize = 40.dp
    val IconSize = 22.dp
    val FieldHeight = 56.dp
    val ControlShape = RoundedCornerShape(16.dp)
    val CardShape = RoundedCornerShape(20.dp)
}

/** 所有页面共用顶栏高度、标题字号和两侧留白。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RemoteTopAppBar(
    title: @Composable () -> Unit,
    navigationIcon: @Composable () -> Unit = {},
    actions: @Composable RowScope.() -> Unit = {},
) {
    TopAppBar(
        modifier = Modifier.padding(horizontal = 8.dp),
        title = { ProvideTextStyle(MaterialTheme.typography.titleLarge, title) },
        navigationIcon = navigationIcon,
        actions = actions,
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.background,
            scrolledContainerColor = MaterialTheme.colorScheme.background,
        ),
    )
}

/** Menus retain Material's anchoring, keyboard focus and outside-tap dismissal. */
@Composable
internal fun NeumorphMenu(expanded: Boolean, onDismissRequest: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismissRequest,
        modifier = Modifier.neumorphRaised(RemoteUi.CardShape),
        shape = RemoteUi.CardShape,
        containerColor = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
        shadowElevation = 0.dp,
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

@Composable
internal fun NeumorphMenuItem(
    text: @Composable () -> Unit,
    onClick: () -> Unit,
    leadingIcon: (@Composable () -> Unit)? = null,
    trailingIcon: (@Composable () -> Unit)? = null,
    enabled: Boolean = true,
) {
    NeumorphSurface(onClick = onClick, enabled = enabled, shape = RemoteUi.ControlShape, shadowScale = 0.4f) {
        Row(
            Modifier.widthIn(min = 200.dp, max = 300.dp).heightIn(min = RemoteUi.TouchTarget).padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            leadingIcon?.invoke()
            Box(Modifier.weight(1f)) { ProvideTextStyle(MaterialTheme.typography.labelLarge, text) }
            trailingIcon?.invoke()
        }
    }
}

/** Keep the native modal semantics; use a soft raised slab and wrapping actions inside it. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun NeumorphDialog(
    onDismissRequest: () -> Unit,
    confirmButton: @Composable () -> Unit,
    title: @Composable () -> Unit,
    text: @Composable () -> Unit,
    dismissButton: (@Composable () -> Unit)? = null,
    shape: Shape = MaterialTheme.shapes.extraLarge,
    properties: DialogProperties = DialogProperties(),
) {
    BasicAlertDialog(onDismissRequest = onDismissRequest, properties = properties, modifier = Modifier.padding(vertical = 12.dp)) {
        NeumorphSurface(shape = shape, shadowScale = 1.1f) {
            Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                ProvideTextStyle(MaterialTheme.typography.titleLarge, title)
                Box(Modifier.weight(1f, fill = false)) { ProvideTextStyle(MaterialTheme.typography.bodyMedium, text) }
                FlowRow(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    dismissButton?.invoke()
                    confirmButton()
                }
            }
        }
    }
}

/** 标签和说明放在凹槽外面，避免内阴影穿过浮动标签或辅助文字。 */
@Composable
internal fun NeumorphTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: (@Composable () -> Unit)? = null,
    placeholder: (@Composable () -> Unit)? = null,
    leadingIcon: (@Composable () -> Unit)? = null,
    supportingText: (@Composable () -> Unit)? = null,
    enabled: Boolean = true,
    isError: Boolean = false,
    singleLine: Boolean = false,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        label?.let {
            ProvideTextStyle(
                MaterialTheme.typography.labelLarge.copy(color = MaterialTheme.colorScheme.onSurfaceVariant),
                it,
            )
        }
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().heightIn(min = RemoteUi.FieldHeight)
                .neumorphInsetOverlay(RemoteUi.ControlShape),
            placeholder = placeholder,
            leadingIcon = leadingIcon,
            enabled = enabled,
            isError = isError,
            singleLine = singleLine,
            minLines = minLines,
            maxLines = maxLines,
            keyboardOptions = keyboardOptions,
            visualTransformation = visualTransformation,
            textStyle = MaterialTheme.typography.bodyLarge,
            colors = neumorphFieldColors(),
            shape = RemoteUi.ControlShape,
        )
        supportingText?.let {
            ProvideTextStyle(
                MaterialTheme.typography.bodySmall.copy(
                    color = if (isError) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                ),
                it,
            )
        }
    }
}
