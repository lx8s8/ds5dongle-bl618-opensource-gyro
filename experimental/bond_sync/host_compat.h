/* The pinned SDK's LittleFS uses strlcpy, which Ubuntu 22.04 lacks. */
#include <stddef.h>
#include <string.h>
static inline size_t ds5_test_strlcpy(char *dst, const char *src, size_t size)
{
    size_t len = strlen(src);
    if (size) {
        size_t copied = len < size - 1 ? len : size - 1;
        memcpy(dst, src, copied);
        dst[copied] = '\0';
    }
    return len;
}
#undef strlcpy
#define strlcpy ds5_test_strlcpy
