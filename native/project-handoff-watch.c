/* Trusted macOS launcher. Event fd 4 never reaches the Node child; fd 3 is IPC. */
#include <sys/event.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <signal.h>
#include <string.h>
/* Delivery wakes kqueue even if it precedes the next kevent wait. */
static void on_signal(int sig) { (void)sig; }
static int notice(const char *kind,int value) { return dprintf(4,"%s %d\n",kind,value)<0?-1:0; }
int main(int argc,char **argv) {
 if(argc<3)return 64;
 const int forwarded[]={SIGINT,SIGTERM,SIGHUP,SIGWINCH};
 sigset_t watched,previous;sigemptyset(&watched);
 for(int i=0;i<4;i++)sigaddset(&watched,forwarded[i]);
 if(sigprocmask(SIG_BLOCK,&watched,&previous)<0)return 70;
 int gate[2];if(pipe(gate))return 70;
 pid_t child=fork();if(child<0)return 70;
 if(child==0){
  close(gate[1]);close(4);close(5);
  char byte;if(read(gate[0],&byte,1)!=1)_exit(71);close(gate[0]);
  if(sigprocmask(SIG_SETMASK,&previous,0)<0)_exit(71);
  execv(argv[1],argv+1);_exit(127);
 }
 close(gate[0]);close(3);
 struct sigaction action;memset(&action,0,sizeof(action));action.sa_handler=on_signal;sigemptyset(&action.sa_mask);
 sigaction(SIGTERM,&action,0);sigaction(SIGINT,&action,0);sigaction(SIGHUP,&action,0);sigaction(SIGWINCH,&action,0);signal(SIGPIPE,SIG_IGN);
 int k=kqueue();struct kevent ev[6];
 EV_SET(&ev[0],child,EVFILT_PROC,EV_ADD|EV_ENABLE|EV_CLEAR,NOTE_FORK|NOTE_EXIT,0,0);
 EV_SET(&ev[1],5,EVFILT_READ,EV_ADD|EV_ENABLE,0,0,0);
 for(int i=0;i<4;i++)EV_SET(&ev[i+2],forwarded[i],EVFILT_SIGNAL,EV_ADD|EV_ENABLE|EV_CLEAR,0,0,0);
 if(k<0||kevent(k,ev,6,0,0,0)<0||sigprocmask(SIG_SETMASK,&previous,0)<0){kill(child,SIGKILL);waitpid(child,0,0);return 72;}
 if(notice("START",child)<0||write(gate[1],"x",1)!=1){kill(child,SIGKILL);waitpid(child,0,0);return 73;}close(gate[1]);
 int armed=0,forked=0,orphaned=0;
 for(;;){
  int n=kevent(k,0,0,ev,6,0);
  if(n<0&&errno==EINTR)continue;
  if(n<0){kill(child,SIGKILL);waitpid(child,0,0);return 74;}
  /* Always consume PROC first, including FORK and EXIT in the same event. */
  for(int i=0;i<n;i++)if(ev[i].filter==EVFILT_PROC){
   if(ev[i].flags&EV_ERROR){kill(child,SIGKILL);waitpid(child,0,0);return 75;}
   if(armed&&(ev[i].fflags&NOTE_FORK)){forked=1;notice("FORK",1);}
   if(ev[i].fflags&NOTE_EXIT){
    int status;while(waitpid(child,&status,0)<0){if(errno!=EINTR)return 76;}
    int code=WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
    notice(forked?"EXIT_UNKNOWN":armed?"EXIT_CLEAN":"EXIT_UNARMED",code);
    return orphaned?1:code;
   }
  }
  for(int i=0;i<n;i++)if(ev[i].filter==EVFILT_SIGNAL)kill(child,(int)ev[i].ident);
  for(int i=0;i<n;i++)if(ev[i].filter==EVFILT_READ){
   char command[32];ssize_t bytes=read(5,command,sizeof(command));
   if(bytes<=0){orphaned=1;kill(child,SIGKILL);continue;}
   if(bytes==4&&!memcmp(command,"ARM\n",4)&&!armed){armed=1;if(notice("ARMED",child)<0){orphaned=1;kill(child,SIGKILL);}}
   else {forked=1;notice("UNKNOWN",1);}
  }
 }
}
