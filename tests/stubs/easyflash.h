#pragma once
#include <stddef.h>
int ef_get_env_blob(const char *key, void *data, size_t len, size_t *saved_len);
int ef_set_env_blob(const char *key, const void *data, size_t len);
