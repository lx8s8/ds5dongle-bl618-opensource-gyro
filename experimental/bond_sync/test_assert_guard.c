#include "extension/assert_guard.h"
#include <assert.h>
#include <stdio.h>
static int good(void *p){return *(int*)p;}
static int fail(void *p){(void)p;bond_assert_failed();}
static int nested(void *p){return bond_guarded_call(good,p);}
int main(void){int n=42;assert(bond_guarded_call(good,&n)==42);assert(bond_guarded_call(fail,0)==-1);assert(bond_guarded_call(good,&n)==42);assert(bond_guarded_call(nested,&n)==-1);assert(bond_guarded_call(good,&n)==42);puts("assert guard: fail closed, clear guard and reject nesting passed");}
