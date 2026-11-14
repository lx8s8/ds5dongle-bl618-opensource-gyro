/* Keep the independent first-stage image below the two partition sectors.
 * Status is exposed over HID and LED, without pulling the floating-point
 * printf implementation into the boot manager. */
int __wrap_printf(const char *format,...){(void)format;return 0;}
int __wrap_puts(const char *text){(void)text;return 0;}
