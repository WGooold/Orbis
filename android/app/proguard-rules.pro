-keepattributes *Annotation*
-keep class go.** { *; }
-keep class orbis.mobile.** { *; }
# MATH-01: Rhino initializes standard objects (including RegExp/JSON) by class name.
# Keep the offline interpreter's names and members in the optimized release build.
-keep class !org.mozilla.javascript.tools.**,org.mozilla.javascript.** { *; }
# Rhino's optional Java-bean JSON converter is not used: the safe scope exchanges
# only JS objects and strings. Android has no java.beans introspection classes.
-dontwarn java.beans.BeanDescriptor
-dontwarn java.beans.BeanInfo
-dontwarn java.beans.IntrospectionException
-dontwarn java.beans.Introspector
-dontwarn java.beans.PropertyDescriptor
-keep,includedescriptorclasses class com.orbising.orbis.**$$serializer { *; }
