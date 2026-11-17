#include "extension.h"
#ifdef BOND_ENABLE_ASSERT_GUARD
#include "assert_guard.h"
#endif
#include <stddef.h>
#include <string.h>
#define BLOCK_SIZE 4096u
#define BLOCK_COUNT 8u
typedef struct { const bond_extension_api *api; uint32_t address; } device;
/* Reject invalid LittleFS block arithmetic before computing a physical address.
 * The caller independently restricts access to the two exact PSM banks. */
int bond_extension_extent_valid(lfs_block_t b,lfs_off_t o,lfs_size_t n){return b<BLOCK_COUNT && o<=BLOCK_SIZE && n<=BLOCK_SIZE-o;}
static int rd(const struct lfs_config *c,lfs_block_t b,lfs_off_t o,void *p,lfs_size_t n){device*d=c->context;if(!bond_extension_extent_valid(b,o,n))return LFS_ERR_CORRUPT;return d->api->read(d->address+b*BLOCK_SIZE+o,p,n)?LFS_ERR_IO:0;}
static int wr(const struct lfs_config *c,lfs_block_t b,lfs_off_t o,const void *p,lfs_size_t n){device*d=c->context;if(!bond_extension_extent_valid(b,o,n))return LFS_ERR_CORRUPT;return d->api->write(d->address+b*BLOCK_SIZE+o,p,n)?LFS_ERR_IO:0;}
static int er(const struct lfs_config *c,lfs_block_t b){device*d=c->context;if(b>=BLOCK_COUNT)return LFS_ERR_CORRUPT;return d->api->erase(d->address+b*BLOCK_SIZE,BLOCK_SIZE)?LFS_ERR_IO:0;}
static int sy(const struct lfs_config *c){(void)c;return 0;}
typedef struct {const bond_extension_api *api;unsigned source_slot;bond_extension_workspace *workspace;} invocation;
static int run_inner(void *context)
{
    invocation *call=context;const bond_extension_api *api=call->api;unsigned source_slot=call->source_slot;bond_extension_workspace *w=call->workspace;
#ifdef BOND_TEST_FORCE_ASSERT
    LFS_ASSERT(0); /* Test-only injection, before mounting or writing. */
#endif
    device src={api,source_slot ? 0x3e9000u : 0x330000u}, dst={api,source_slot ? 0x330000u : 0x3e9000u};
    w->src_config=(struct lfs_config){.context=&src,.read=rd,.prog=wr,.erase=er,.sync=sy,.read_size=256,.prog_size=256,.block_size=BLOCK_SIZE,.block_count=BLOCK_COUNT,.cache_size=512,.lookahead_size=256,.block_cycles=500,.read_buffer=w->src_read,.prog_buffer=w->src_prog,.lookahead_buffer=w->src_lookahead};
    w->dst_config=(struct lfs_config){.context=&dst,.read=rd,.prog=wr,.erase=er,.sync=sy,.read_size=256,.prog_size=256,.block_size=BLOCK_SIZE,.block_count=BLOCK_COUNT,.cache_size=512,.lookahead_size=256,.block_cycles=500,.read_buffer=w->dst_read,.prog_buffer=w->dst_prog,.lookahead_buffer=w->dst_lookahead};
    int rc=lfs_mount(&w->source,&w->src_config);
    if(rc>=0){
        rc=lfs_mount(&w->target,&w->dst_config);
        if(rc>=0){rc=bond_sync_lfs(&w->source,&w->target,&w->sync);lfs_unmount(&w->target);}
        lfs_unmount(&w->source);
    }
    return rc;
}
#ifdef __riscv
__attribute__((section(".entry"),used))
#endif
int bond_extension_run(const bond_extension_api *api, unsigned source_slot, bond_extension_workspace *w)
{
    if (!api || api->api_version != 1 || !api->read || !api->write || !api->erase || !w || source_slot > 1) return BOND_SYNC_FORMAT;
    invocation call={api,source_slot,w};
#ifdef BOND_ENABLE_ASSERT_GUARD
    int rc=bond_guarded_call(run_inner,&call);
#else
    int rc=run_inner(&call);
#endif
    /* The workspace contains credentials. Clear it even after an assertion. */
    volatile uint8_t *p=(volatile uint8_t*)w;for(size_t i=0;i<sizeof(*w);i++)p[i]=0;
    return rc;
}
