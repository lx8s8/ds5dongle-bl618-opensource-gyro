#include "bond_sync.h"
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#define SIZE 32768
#define BLOCK 4096
#define KEY "/_ef4_kvs_/link_key"
#define CFG "/_ef4_kvs_/dongle_cfg"

typedef struct { uint8_t data[SIZE]; int fail_after, writes; bool dead, partial; _Alignas(8) uint8_t rb[512],pb[512],lb[256]; } disk;
static int rd(const struct lfs_config*c,lfs_block_t b,lfs_off_t o,void*p,lfs_size_t n){disk*d=c->context;if(d->dead)return LFS_ERR_IO;memcpy(p,d->data+b*BLOCK+o,n);return 0;}
static int pr(const struct lfs_config*c,lfs_block_t b,lfs_off_t o,const void*p,lfs_size_t n){disk*d=c->context;if(d->dead)return LFS_ERR_IO;bool fault=d->fail_after>=0&&d->writes++==d->fail_after;uint8_t*to=d->data+b*BLOCK+o;const uint8_t*from=p;unsigned end=fault?(d->partial?n/2:0):n;for(unsigned i=0;i<end;i++){if((to[i]&from[i])!=from[i])return LFS_ERR_IO;to[i]&=from[i];}if(fault){d->dead=true;return LFS_ERR_IO;}return 0;}
static int er(const struct lfs_config*c,lfs_block_t b){disk*d=c->context;if(d->dead)return LFS_ERR_IO;bool fault=d->fail_after>=0&&d->writes++==d->fail_after;memset(d->data+b*BLOCK,255,fault?(d->partial?BLOCK/2:0):BLOCK);if(fault){d->dead=true;return LFS_ERR_IO;}return 0;}
static int sy(const struct lfs_config*c){return ((disk*)c->context)->dead?LFS_ERR_IO:0;}
static struct lfs_config config(disk*d){return(struct lfs_config){.context=d,.read=rd,.prog=pr,.erase=er,.sync=sy,.read_size=256,.prog_size=256,.block_size=BLOCK,.block_count=8,.cache_size=512,.lookahead_size=256,.block_cycles=500,.read_buffer=d->rb,.prog_buffer=d->pb,.lookahead_buffer=d->lb};}
static void put(lfs_t*l,const char*path,const void*b,size_t n){lfs_file_t f;uint8_t cache[512];struct lfs_file_config fc={.buffer=cache};assert(!lfs_file_opencfg(l,&f,path,LFS_O_WRONLY|LFS_O_CREAT|LFS_O_TRUNC,&fc));assert(lfs_file_write(l,&f,b,n)==(lfs_ssize_t)n);assert(!lfs_file_close(l,&f));}
static int get(lfs_t*l,const char*path,void*b,size_t n){lfs_file_t f;uint8_t cache[512];struct lfs_file_config fc={.buffer=cache};int e=lfs_file_opencfg(l,&f,path,LFS_O_RDONLY,&fc);if(e<0)return e;int r=lfs_file_read(l,&f,b,n);assert(!lfs_file_close(l,&f));return r;}
static void fresh(disk*d,lfs_t*l,struct lfs_config*c){memset(d,0,sizeof *d);memset(d->data,255,SIZE);d->fail_after=-1;*c=config(d);assert(!lfs_format(l,c));assert(!lfs_mount(l,c));assert(!lfs_mkdir(l,"/_ef4_kvs_"));}
static void rec(uint8_t b[196],int n){memset(b,0,196);b[194]=0xa6;b[195]=0xa5;if(n){b[0]=n;b[6]=1;memset(b+7,n,16);b[184]=1;}}
static void check_cfg(lfs_t*l){char buf[32]={0};assert(get(l,CFG,buf,sizeof buf)==11);assert(!memcmp(buf,"user-config",11));}
int main(void){disk sd,base;lfs_t src,dst;struct lfs_config sc,dc;fresh(&sd,&src,&sc);fresh(&base,&dst,&dc);uint8_t old[196],newkey[196],out[196];rec(old,1);rec(newkey,2);put(&src,KEY,newkey,196);put(&dst,KEY,old,196);put(&dst,CFG,"user-config",11);assert(!lfs_unmount(&dst));disk original=base;bond_sync_workspace workspace;
 int checked=0;
 for(int partial=0;partial<2;partial++)for(int fail=0;fail<100;fail++){
  disk trial=original;trial.fail_after=fail;trial.writes=0;trial.dead=false;trial.partial=partial;dc=config(&trial);assert(!lfs_mount(&dst,&dc));int result=bond_sync_lfs(&src,&dst,&workspace);int writes=trial.writes;
  if(!trial.dead)assert(!lfs_unmount(&dst));trial.dead=false;trial.fail_after=-1;dc=config(&trial);assert(!lfs_mount(&dst,&dc));check_cfg(&dst);assert(get(&dst,KEY,out,sizeof out)==196);assert(!memcmp(out,old,196)||!memcmp(out,newkey,196));int retry=bond_sync_lfs(&src,&dst,&workspace);assert(retry==BOND_SYNC_OK||retry==BOND_SYNC_CHANGED);assert(get(&dst,KEY,out,196)==196&&!memcmp(out,newkey,196));check_cfg(&dst);assert(!lfs_unmount(&dst));checked++;
  if(result==BOND_SYNC_CHANGED && fail>=writes)break;
 }
 disk trial=original;trial.fail_after=-1;dc=config(&trial);assert(!lfs_mount(&dst,&dc));assert(bond_sync_lfs(&src,&dst,&workspace)==BOND_SYNC_CHANGED);check_cfg(&dst);assert(get(&dst,KEY,out,sizeof out)==196&&!memcmp(out,newkey,196));assert(bond_sync_lfs(&src,&dst,&workspace)==BOND_SYNC_OK);
 /* An empty, valid record propagates deletion; missing/unknown source does not. */
 uint8_t empty[196];rec(empty,0);put(&src,KEY,empty,196);
 /* Interrupted deletion may retain the old record or commit the empty one;
  * a retry must converge without changing the receiver configuration. */
 for(int partial=0;partial<2;partial++)for(int fail=0;fail<100;fail++){
  disk tmp=original;tmp.fail_after=fail;tmp.writes=0;tmp.dead=false;tmp.partial=partial;struct lfs_config tc=config(&tmp);lfs_t tl;assert(!lfs_mount(&tl,&tc));int result=bond_sync_lfs(&src,&tl,&workspace);int writes=tmp.writes;
  if(!tmp.dead)assert(!lfs_unmount(&tl));tmp.dead=false;tmp.fail_after=-1;tc=config(&tmp);assert(!lfs_mount(&tl,&tc));check_cfg(&tl);assert(get(&tl,KEY,out,196)==196);assert(!memcmp(out,old,196)||!memcmp(out,empty,196));int retry=bond_sync_lfs(&src,&tl,&workspace);assert(retry==BOND_SYNC_OK||retry==BOND_SYNC_CHANGED);assert(get(&tl,KEY,out,196)==196&&!memcmp(out,empty,196));check_cfg(&tl);assert(!lfs_unmount(&tl));checked++;if(result==BOND_SYNC_CHANGED&&fail>=writes)break;
 }
 assert(bond_sync_lfs(&src,&dst,&workspace)==BOND_SYNC_CHANGED);assert(get(&dst,KEY,out,196)==196&&!memcmp(out,empty,196));check_cfg(&dst);
 assert(!lfs_remove(&src,KEY));assert(bond_sync_lfs(&src,&dst,&workspace)==BOND_SYNC_CONFLICT);assert(get(&dst,KEY,out,196)==196&&!memcmp(out,empty,196));
 put(&src,KEY,"bad",3);assert(bond_sync_lfs(&src,&dst,&workspace)==BOND_SYNC_FORMAT);check_cfg(&dst);
 /* Reject duplicate addresses and invalid used flags rather than propagating
  * a malformed store into the other firmware. */
 uint8_t malformed[196];rec(malformed,7);memcpy(malformed+23,malformed,23);malformed[185]=1;put(&src,KEY,malformed,196);assert(bond_sync_lfs(&src,&dst,&workspace)==BOND_SYNC_FORMAT);check_cfg(&dst);
 rec(malformed,7);malformed[184]=2;put(&src,KEY,malformed,196);assert(bond_sync_lfs(&src,&dst,&workspace)==BOND_SYNC_FORMAT);check_cfg(&dst);
 assert(!lfs_unmount(&dst));assert(!lfs_unmount(&src));printf("bond sync: copy, deletion, conflict and %d interrupted writes verified\n",checked);return 0;}
