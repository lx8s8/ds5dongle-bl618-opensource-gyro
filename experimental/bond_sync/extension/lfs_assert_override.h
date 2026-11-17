#pragma once
#include "assert_guard.h"
/* Failure unwinds to the manager-owned guarded call, never to application. */
#define LFS_ASSERT(condition) ((condition) ? (void)0 : bond_assert_failed())
